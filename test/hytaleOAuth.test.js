import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
    HYTALE_OAUTH_ISSUER,
    HYTALE_OAUTH_SCOPE,
    buildHytaleAuthorizationUrl,
    createHytaleOAuthState,
    normalizeHytaleIdentity
} from "../utils/hytaleOAuth.js";

test("creates an S256 PKCE request with independent state and nonce", () => {
    const oauth = createHytaleOAuthState();
    const expectedChallenge = crypto.createHash("sha256")
        .update(oauth.verifier)
        .digest("base64url");

    assert.match(oauth.state, /^[A-Za-z0-9_-]+$/);
    assert.match(oauth.nonce, /^[A-Za-z0-9_-]+$/);
    assert.match(oauth.verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(oauth.challenge, expectedChallenge);
    assert.notEqual(oauth.state, oauth.nonce);
});

test("builds the documented Hytale authorization code request", () => {
    const url = new URL(buildHytaleAuthorizationUrl({
        clientId: "client-id",
        redirectUri: "http://localhost:3000/api/account/oauth/hytale/callback",
        state: "state-value",
        nonce: "nonce-value",
        challenge: "challenge-value"
    }));

    assert.equal(url.origin, HYTALE_OAUTH_ISSUER);
    assert.equal(url.pathname, "/oauth2/auth");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("scope"), HYTALE_OAUTH_SCOPE);
    assert.equal(url.searchParams.get("state"), "state-value");
    assert.equal(url.searchParams.get("nonce"), "nonce-value");
    assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("normalizes matching ID token and UserInfo identity claims", () => {
    const subject = "a".repeat(43);
    const result = normalizeHytaleIdentity(
        { sub: subject },
        {
            sub: subject,
            profile: {
                uuid: "12345678-1234-1234-1234-123456789abc",
                username: "ExamplePlayer"
            }
        }
    );

    assert.deepEqual(result, {
        subject,
        profileUuid: "12345678-1234-1234-1234-123456789abc",
        profileUsername: "ExamplePlayer"
    });
});

test("rejects subject mismatches and malformed selected profiles", () => {
    assert.deepEqual(
        normalizeHytaleIdentity(
            { sub: "a".repeat(43) },
            {
                sub: "b".repeat(43),
                profile: {
                    uuid: "12345678-1234-1234-1234-123456789abc",
                    username: "ExamplePlayer"
                }
            }
        ),
        { error: "invalid_subject" }
    );

    assert.deepEqual(
        normalizeHytaleIdentity(
            { sub: "a".repeat(43) },
            {
                sub: "a".repeat(43),
                profile: { uuid: "", username: "ExamplePlayer" }
            }
        ),
        { error: "invalid_profile" }
    );
});
