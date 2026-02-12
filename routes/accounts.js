import express from "express";
import { createAccount, getAccountByEmail, getAccountThatOwnsPlugin, getSessionMaxAgeMs, setCurseforgeLink, setGithubLink, toPublicAccount, toSafeAccount, touchLastLogin, updatePassword, verifyPassword } from "../databases/accountsdb.js";
import requireSession from "../middleware/requireSession.js";
import { authRateLimiter } from "../middleware/rateLimiters.js";

const router = express.Router();
const RECAPTCHA_VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";

function validateEmail(email) {
    return typeof email === "string" && email.includes("@") && email.length <= 320;
}

function validatePassword(password) {
    return typeof password === "string" && password.length >= 8 && password.length <= 128;
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

router.post("/apply-github-link", requireSession, (req, res) => {
    const { github_link } = req.body || {};
    if (typeof github_link !== "string" || !github_link.startsWith("https://github.com/")) {
        return res.status(400).json({ error: "Invalid GitHub link" });
    }
    setGithubLink(req.account.id, github_link);
    res.json({ status: "success" });
});

router.post("/apply-curseforge-link", requireSession, (req, res) => {
    const { curseforge_link } = req.body || {};
    if (typeof curseforge_link !== "string" || !curseforge_link.startsWith("https://www.curseforge.com/members/")) {
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
