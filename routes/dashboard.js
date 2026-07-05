import express from "express";
import { computeStats } from "../lib/stats.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    res.json(await computeStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
