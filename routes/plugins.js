import express from 'express';

const router = express.Router();

router.post("/add-plugin", (req, res) => {
    res.status(501).json({ error: "Not implemented yet" });
});

export default router;