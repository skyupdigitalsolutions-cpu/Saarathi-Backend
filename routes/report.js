import express from "express";
import {
  generateDailyReport,
  formatForTelegram,
  sendToTelegram,
  telegramConfigured,
} from "../lib/report.js";

const router = express.Router();

// GET /api/report/daily — structured report + AI narrative (for the in-app page)
router.get("/daily", async (req, res) => {
  try {
    res.json(await generateDailyReport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/report/telegram/status — is Telegram wired up?
router.get("/telegram/status", (req, res) => {
  res.json({ configured: telegramConfigured() });
});

// POST /api/report/telegram — generate a fresh report and push it to Telegram
router.post("/telegram", async (req, res) => {
  try {
    const report = await generateDailyReport();
    const result = await sendToTelegram(formatForTelegram(report));
    if (!result.sent) return res.status(result.error?.includes("not configured") ? 400 : 502).json(result);
    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ sent: false, error: err.message });
  }
});

export default router;
