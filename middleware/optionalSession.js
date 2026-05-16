import { getAccountById } from "../databases/accountsdb.js";

function optionalSession(req, res, next) {
    if (!req.session?.accountId) {
        return next();
    }

    const account = getAccountById(req.session.accountId);
    if (account && !account.is_disabled) {
        req.account = account;
    }

    return next();
}

export default optionalSession;
