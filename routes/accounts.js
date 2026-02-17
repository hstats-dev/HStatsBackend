import express from "express";
import crypto from "crypto";
import {
    createAccount,
    createDiscordAccount,
    getAccountByDiscordId,
    getAccountByEmail,
    getAccountThatOwnsPlugin,
    getSessionMaxAgeMs,
    linkDiscordToAccount,
    setCurseforgeLink,
    setGithubLink,
    syncEmailIfMissing,
    toPublicAccount,
    toSafeAccount,
    touchLastLogin,
    updatePassword,
    verifyPassword
} from "../databases/accountsdb.js";
import requireSession from "../middleware/requireSession.js";
import { authRateLimiter } from "../middleware/rateLimiters.js";
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../config.js";

const router = express.Router();
const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const DISCORD_OAUTH_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_OAUTH_TOKEN_URL = "https://discord.com/api/oauth2/token";
const DISCORD_OAUTH_USER_URL = "https://discord.com/api/users/@me";
const DISCORD_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const FRONTEND_ORIGIN = process.env.DISCORD_OAUTH_FRONTEND_ORIGIN
    || (process.env.PRODUCTION === "true" ? "https://hstats.dev" : "http://localhost:5173");

function validateEmail(email) {
    return typeof email === "string" && email.includes("@") && email.length <= EMAIL_MAX_LENGTH;
}

function validatePassword(password) {
    return typeof password === "string" && password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}

function getDiscordRedirectUri(req) {
    if (typeof process.env.DISCORD_OAUTH_REDIRECT_URI === "string" && process.env.DISCORD_OAUTH_REDIRECT_URI.trim()) {
        return process.env.DISCORD_OAUTH_REDIRECT_URI.trim();
    }
    return `${req.protocol}://${req.get("host")}${req.baseUrl}/oauth/discord/callback`;
}

function getFrontendReturnPath(rawPath) {
    if (typeof rawPath !== "string" || !rawPath.startsWith("/") || rawPath.startsWith("//")) {
        return "/";
    }
    return rawPath;
}

function buildFrontendRedirect(path, status, errorCode) {
    const target = new URL(path, FRONTEND_ORIGIN);
    target.searchParams.set("oauth_provider", "discord");
    target.searchParams.set("oauth_status", status);
    if (errorCode) {
        target.searchParams.set("oauth_error", errorCode);
    }
    return target.toString();
}

function getDiscordDisplayName(profile) {
    if (typeof profile?.global_name === "string" && profile.global_name.trim()) {
        return profile.global_name.trim();
    }
    if (typeof profile?.username === "string" && profile.username.trim()) {
        return profile.username.trim();
    }
    return "";
}

function isDiscordOauthConfigured() {
    return Boolean(typeof process.env.DISCORD_OAUTH_CLIENT_ID === "string"
        && process.env.DISCORD_OAUTH_CLIENT_ID.trim()
        && typeof process.env.DISCORD_OAUTH_CLIENT_SECRET === "string"
        && process.env.DISCORD_OAUTH_CLIENT_SECRET.trim());
}

async function exchangeDiscordCodeForToken(code, redirectUri) {
    const body = new URLSearchParams();
    body.set("client_id", process.env.DISCORD_OAUTH_CLIENT_ID.trim());
    body.set("client_secret", process.env.DISCORD_OAUTH_CLIENT_SECRET.trim());
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("scope", "identify email");

    const response = await fetch(DISCORD_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.access_token) {
        return null;
    }

    return payload.access_token;
}

async function fetchDiscordProfile(accessToken) {
    const response = await fetch(DISCORD_OAUTH_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
        return null;
    }
    return response.json();
}

function resolveAccountForDiscordProfile(profile) {
    const discordId = typeof profile?.id === "string" ? profile.id.trim() : "";
    if (!discordId) {
        return { error: "Invalid Discord profile" };
    }

    const discordUsername = getDiscordDisplayName(profile);
    const maybeEmail = typeof profile?.email === "string" && validateEmail(profile.email) ? profile.email : null;
    const verifiedEmail = profile?.verified === true ? maybeEmail : null;

    const existingByDiscord = getAccountByDiscordId(discordId);
    if (existingByDiscord) {
        if (existingByDiscord.is_disabled) {
            return existingByDiscord;
        }
        const linked = linkDiscordToAccount(existingByDiscord.id, { discordId, discordUsername });
        if (linked?.error) {
            return linked;
        }
        if (verifiedEmail) {
            return syncEmailIfMissing(linked.id, verifiedEmail);
        }
        return linked;
    }

    if (verifiedEmail) {
        const existingByEmail = getAccountByEmail(verifiedEmail);
        if (existingByEmail) {
            if (existingByEmail.is_disabled) {
                return existingByEmail;
            }
            const linked = linkDiscordToAccount(existingByEmail.id, { discordId, discordUsername });
            if (linked?.error) {
                return linked;
            }
            return syncEmailIfMissing(linked.id, verifiedEmail);
        }
    }

    return createDiscordAccount({
        discordId,
        discordUsername,
        email: verifiedEmail
    });
}

async function verifyRecaptcha(recaptchaToken, remoteIp) {
    const secretKey = process.env.RECAPTCHA_SECRET_KEY;
    if (!secretKey) {
        return {
            ok: false,
            type: "config",
            message: "RECAPTCHA_SECRET_KEY is not configured"
        };
    }

    try {
        const body = new URLSearchParams();
        body.set("secret", secretKey);
        body.set("response", recaptchaToken);
        if (remoteIp) {
            body.set("remoteip", remoteIp);
        }

        const response = await fetch(RECAPTCHA_VERIFY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body
        });

        if (!response.ok) {
            return {
                ok: false,
                type: "upstream",
                message: "Failed to reach reCAPTCHA verification service"
            };
        }

        const payload = await response.json();
        if (!payload.success) {
            return {
                ok: false,
                type: "invalid",
                errors: payload["error-codes"] || []
            };
        }

        const minScoreRaw = process.env.RECAPTCHA_MIN_SCORE;
        if (minScoreRaw !== undefined && minScoreRaw !== "") {
            const minScore = Number.parseFloat(minScoreRaw);
            if (Number.isFinite(minScore) && typeof payload.score === "number" && payload.score < minScore) {
                return {
                    ok: false,
                    type: "invalid",
                    errors: ["low-score"]
                };
            }
        }

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            type: "upstream",
            message: "Error verifying reCAPTCHA"
        };
    }
}

router.post("/register", authRateLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!validateEmail(email)) {
        return res.status(400).json({ error: "Invalid email" });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: "Invalid password" });
    }

    const recaptchaToken = req.body?.recaptcha_token || req.body?.recaptchaToken || req.body?.["g-recaptcha-response"];
    if (typeof recaptchaToken !== "string" || !recaptchaToken.trim()) {
        return res.status(400).json({ error: "Missing reCAPTCHA token" });
    }

    const recaptchaResult = await verifyRecaptcha(recaptchaToken, req.clientIp || req.ip);
    if (!recaptchaResult.ok) {
        if (recaptchaResult.type === "config") {
            return res.status(500).json({ error: "reCAPTCHA is not configured on the server" });
        }
        if (recaptchaResult.type === "upstream") {
            return res.status(502).json({ error: "Unable to verify reCAPTCHA right now" });
        }
        return res.status(400).json({
            error: "Invalid reCAPTCHA",
            recaptcha_errors: recaptchaResult.errors || []
        });
    }

    const result = createAccount({ email, password });
    if (result?.error) {
        return res.status(409).json({ error: result.error });
    }

    req.session.accountId = result.id;
    req.session.cookie.maxAge = getSessionMaxAgeMs();
    touchLastLogin(result.id);
    res.status(201).json({ account: toSafeAccount(result) });
});

router.post("/login", authRateLimiter, (req, res) => {
    const { email, password } = req.body || {};
    if (!validateEmail(email)) {
        return res.status(400).json({ error: "Invalid email" });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: "Invalid password" });
    }

    const account = getAccountByEmail(email);
    if (!account || account.is_disabled) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!verifyPassword(account, password)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.accountId = account.id;
    req.session.cookie.maxAge = getSessionMaxAgeMs();
    touchLastLogin(account.id);
    res.json({ account: toSafeAccount(account) });
});

router.get("/oauth/discord/start", authRateLimiter, (req, res) => {
    if (!isDiscordOauthConfigured()) {
        return res.status(500).json({ error: "Discord OAuth is not configured on the server" });
    }

    const state = crypto.randomBytes(24).toString("hex");
    const returnPath = getFrontendReturnPath(req.query?.return_to);
    req.session.discordOAuth = {
        state,
        expires_at: Date.now() + DISCORD_OAUTH_STATE_TTL_MS,
        return_path: returnPath
    };

    const redirectUri = getDiscordRedirectUri(req);
    const authUrl = new URL(DISCORD_OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set("client_id", process.env.DISCORD_OAUTH_CLIENT_ID.trim());
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", "identify email");
    authUrl.searchParams.set("state", state);

    if (req.query?.mode === "json") {
        return res.json({ authorization_url: authUrl.toString() });
    }

    return res.redirect(authUrl.toString());
});

router.get("/oauth/discord/callback", authRateLimiter, async (req, res) => {
    const oauthState = req.session?.discordOAuth;
    const returnPath = getFrontendReturnPath(oauthState?.return_path);
    req.session.discordOAuth = null;

    const state = typeof req.query?.state === "string" ? req.query.state : "";
    const code = typeof req.query?.code === "string" ? req.query.code : "";
    const stateIsValid = oauthState
        && typeof oauthState.state === "string"
        && oauthState.state
        && typeof oauthState.expires_at === "number"
        && oauthState.expires_at > Date.now()
        && oauthState.state === state;

    if (!stateIsValid) {
        return res.redirect(buildFrontendRedirect(returnPath, "error", "invalid_state"));
    }
    if (!code) {
        return res.redirect(buildFrontendRedirect(returnPath, "error", "missing_code"));
    }
    if (!isDiscordOauthConfigured()) {
        return res.redirect(buildFrontendRedirect(returnPath, "error", "server_misconfigured"));
    }

    try {
        const accessToken = await exchangeDiscordCodeForToken(code, getDiscordRedirectUri(req));
        if (!accessToken) {
            return res.redirect(buildFrontendRedirect(returnPath, "error", "token_exchange_failed"));
        }

        const profile = await fetchDiscordProfile(accessToken);
        if (!profile) {
            return res.redirect(buildFrontendRedirect(returnPath, "error", "profile_fetch_failed"));
        }

        const account = resolveAccountForDiscordProfile(profile);
        if (!account || account?.error) {
            return res.redirect(buildFrontendRedirect(returnPath, "error", "account_link_failed"));
        }
        if (account.is_disabled) {
            return res.redirect(buildFrontendRedirect(returnPath, "error", "account_disabled"));
        }

        req.session.accountId = account.id;
        req.session.cookie.maxAge = getSessionMaxAgeMs();
        touchLastLogin(account.id);
        return res.redirect(buildFrontendRedirect(returnPath, "success"));
    } catch (error) {
        return res.redirect(buildFrontendRedirect(returnPath, "error", "unexpected_error"));
    }
});

router.post("/apply-github-link", requireSession, (req, res) => {
    const { github_link } = req.body || {};
    if (typeof github_link !== "string") {
        return res.status(400).json({ error: "Invalid GitHub link" });
    }

    if (github_link.trim() === "") {
        setGithubLink(req.account.id, null);
        return res.json({ status: "success" });
    }

    if (!github_link.startsWith("https://github.com/")) {
        return res.status(400).json({ error: "Invalid GitHub link" });
    }
    setGithubLink(req.account.id, github_link);
    res.json({ status: "success" });
});

router.post("/apply-curseforge-link", requireSession, (req, res) => {
    const { curseforge_link } = req.body || {};
    if (typeof curseforge_link !== "string") {
        return res.status(400).json({ error: "Invalid CurseForge link" });
    }

    if (curseforge_link.trim() === "") {
        setCurseforgeLink(req.account.id, null);
        return res.json({ status: "success" });
    }

    if (!curseforge_link.startsWith("https://www.curseforge.com/members/")) {
        return res.status(400).json({ error: "Invalid CurseForge link" });
    }
    setCurseforgeLink(req.account.id, curseforge_link);
    res.json({ status: "success" });
});

router.get("/get-plugin-ownership/:plugin_uuid", requireSession, (req, res) => {
    const { plugin_uuid } = req.params || {};
    if (typeof plugin_uuid !== "string") {
        return res.status(400).json({ error: "Invalid plugin UUID" });
    }
    const account = getAccountThatOwnsPlugin(plugin_uuid);
    if (!account) {
        return res.status(404).json({ error: "No account owns this plugin" });
    }
    res.json({ account: toPublicAccount(account) });
});

router.get("/me", requireSession, (req, res) => {
    res.json({ account: toSafeAccount(req.account) });
});

router.post("/logout", requireSession, (req, res) => {
    req.session.destroy(() => {
        res.json({ status: "success" });
    });
});

router.post("/change-password", requireSession, (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!validatePassword(new_password)) {
        return res.status(400).json({ error: "Invalid new password" });
    }
    if (!verifyPassword(req.account, current_password || "")) {
        return res.status(401).json({ error: "Invalid current password" });
    }
    updatePassword(req.account.id, new_password);
    res.json({ status: "success" });
});

export default router;
