import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const HYTALE_OAUTH_ISSUER = "https://connect.accounts.hytale.com";
const HYTALE_OAUTH_AUTHORIZE_URL = `${HYTALE_OAUTH_ISSUER}/oauth2/auth`;
const HYTALE_OAUTH_TOKEN_URL = `${HYTALE_OAUTH_ISSUER}/oauth2/token`;
const HYTALE_OAUTH_USERINFO_URL = `${HYTALE_OAUTH_ISSUER}/userinfo`;
const HYTALE_OAUTH_JWKS_URL = `${HYTALE_OAUTH_ISSUER}/.well-known/jwks.json`;
const HYTALE_OAUTH_SCOPE = "openid hytale:profile";
const HYTALE_OAUTH_TIMEOUT_MS = 10_000;

const hytaleJwks = createRemoteJWKSet(new URL(HYTALE_OAUTH_JWKS_URL), {
    timeoutDuration: HYTALE_OAUTH_TIMEOUT_MS,
    cooldownDuration: 30_000
});

function base64Url(buffer) {
    return Buffer.from(buffer).toString("base64url");
}

function createHytaleOAuthState() {
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    return {
        state: base64Url(crypto.randomBytes(32)),
        nonce: base64Url(crypto.randomBytes(32)),
        verifier,
        challenge
    };
}

function buildHytaleAuthorizationUrl({ clientId, redirectUri, state, nonce, challenge }) {
    const url = new URL(HYTALE_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", HYTALE_OAUTH_SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
}

async function exchangeHytaleCode({ clientId, clientSecret, code, redirectUri, verifier }) {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("code_verifier", verifier);

    const basicCredentials = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const response = await fetch(HYTALE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${basicCredentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
        },
        body,
        signal: AbortSignal.timeout(HYTALE_OAUTH_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error("Hytale token exchange failed");
        error.oauthCode = typeof payload?.error === "string" ? payload.error : "token_exchange_failed";
        throw error;
    }
    if (typeof payload?.access_token !== "string" || !payload.access_token
        || typeof payload?.id_token !== "string" || !payload.id_token) {
        const error = new Error("Hytale token response was incomplete");
        error.oauthCode = "invalid_token_response";
        throw error;
    }

    return payload;
}

async function verifyHytaleIdToken({ idToken, clientId, nonce }) {
    const { payload } = await jwtVerify(idToken, hytaleJwks, {
        algorithms: ["RS256"],
        issuer: HYTALE_OAUTH_ISSUER,
        audience: clientId,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
        clockTolerance: 5
    });

    if (typeof payload.nonce !== "string" || payload.nonce !== nonce) {
        const error = new Error("Hytale ID token nonce mismatch");
        error.oauthCode = "invalid_nonce";
        throw error;
    }

    return payload;
}

async function fetchHytaleUserInfo(accessToken) {
    const response = await fetch(HYTALE_OAUTH_USERINFO_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json"
        },
        signal: AbortSignal.timeout(HYTALE_OAUTH_TIMEOUT_MS)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error("Hytale UserInfo request failed");
        error.oauthCode = "profile_fetch_failed";
        throw error;
    }
    return payload;
}

function normalizeHytaleIdentity(idTokenClaims, userInfoClaims) {
    const idTokenSubject = typeof idTokenClaims?.sub === "string" ? idTokenClaims.sub.trim() : "";
    const userInfoSubject = typeof userInfoClaims?.sub === "string" ? userInfoClaims.sub.trim() : "";
    if (!idTokenSubject
        || idTokenSubject.length > 255
        || idTokenSubject !== userInfoSubject
        || !/^[A-Za-z0-9_-]+$/.test(idTokenSubject)) {
        return { error: "invalid_subject" };
    }

    const profile = userInfoClaims?.profile;
    const profileUuid = typeof profile?.uuid === "string" ? profile.uuid.trim() : "";
    const profileUsername = typeof profile?.username === "string" ? profile.username.trim() : "";
    const profileUuidIsValid = profileUuid
        && profileUuid.length <= 128
        && !/[\s\u0000-\u001f]/.test(profileUuid);
    const profileUsernameIsValid = profileUsername
        && profileUsername.length <= 64
        && !/[\u0000-\u001f]/.test(profileUsername);
    if (!profileUuidIsValid || !profileUsernameIsValid) {
        return { error: "invalid_profile" };
    }

    return {
        subject: idTokenSubject,
        profileUuid,
        profileUsername
    };
}

export {
    HYTALE_OAUTH_ISSUER,
    HYTALE_OAUTH_SCOPE,
    buildHytaleAuthorizationUrl,
    createHytaleOAuthState,
    exchangeHytaleCode,
    fetchHytaleUserInfo,
    normalizeHytaleIdentity,
    verifyHytaleIdToken
};
