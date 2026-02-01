import express from "express";
import { createAccount, getAccountByEmail, getSessionMaxAgeMs, toSafeAccount, touchLastLogin, updatePassword, verifyPassword } from "../databases/accountsdb.js";
import requireSession from "../middleware/requireSession.js";

const router = express.Router();

function validateEmail(email) {
    return typeof email === "string" && email.includes("@") && email.length <= 320;
}

function validatePassword(password) {
    return typeof password === "string" && password.length >= 8 && password.length <= 128;
}

router.post("/register", (req, res) => {
    const { email, password } = req.body || {};
    if (!validateEmail(email)) {
        return res.status(400).json({ error: "Invalid email" });
    }
    if (!validatePassword(password)) {
        return res.status(400).json({ error: "Invalid password" });
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

router.post("/login", (req, res) => {
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
