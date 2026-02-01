import { getAccountById } from "../databases/accountsdb.js";

function requireSession(req, res, next) {
    if (!req.session?.accountId) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    const account = getAccountById(req.session.accountId);
    if (!account || account.is_disabled) {
        return res.status(401).json({ error: "Not authenticated" });
    }
    req.account = account;
    return next();
}

export default requireSession;
