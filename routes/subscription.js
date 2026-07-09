import { Router } from "express";
import { getSubscription, computeStatus } from "../models/Subscription.js";
import { checkExpiryAndAlert } from "../lib/subscription.js";
import { requireDeveloper } from "../lib/auth.js";

const router = Router();

/** PUBLIC — live status for the frontend banner / lock screen. */
router.get("/status", async (req, res) => {
  try {
    const sub = await getSubscription();
    res.json(computeStatus(sub));
  } catch (err) {
    res.status(500).json({ error: "status_failed", message: err.message });
  }
});

/** DEV — full detail (same as status; kept for the panel). */
router.get("/", requireDeveloper, async (req, res) => {
  const sub = await getSubscription();
  res.json(computeStatus(sub));
});

/** DEV — set start/end dates, plan, enabled flag. */
router.post("/", requireDeveloper, async (req, res) => {
  try {
    const sub = await getSubscription();
    const { startDate, endDate, enabled, plan } = req.body || {};
    if (startDate !== undefined) sub.startDate = new Date(startDate);
    if (endDate !== undefined) sub.endDate = new Date(endDate);
    if (typeof enabled === "boolean") sub.enabled = enabled;
    if (plan) sub.plan = plan;
    if (isNaN(new Date(sub.startDate)) || isNaN(new Date(sub.endDate)))
      return res.status(400).json({ error: "bad_date", message: "Invalid start or end date." });
    sub.lastExpiredNotified = false;
    await sub.save();
    await checkExpiryAndAlert();
    res.json(computeStatus(sub));
  } catch (err) {
    res.status(500).json({ error: "update_failed", message: err.message });
  }
});

/** DEV — renew: start today, end in N days (default 30), re-enable. */
router.post("/renew", requireDeveloper, async (req, res) => {
  try {
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : 30;
    const sub = await getSubscription();
    const now = new Date();
    sub.startDate = now;
    sub.endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    sub.enabled = true;
    sub.lastExpiredNotified = false;
    sub.lastAlertDate = "";
    await sub.save();
    res.json(computeStatus(sub));
  } catch (err) {
    res.status(500).json({ error: "renew_failed", message: err.message });
  }
});

/** DEV — master enable/disable toggle. */
router.post("/toggle", requireDeveloper, async (req, res) => {
  try {
    const sub = await getSubscription();
    sub.enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : !sub.enabled;
    await sub.save();
    res.json(computeStatus(sub));
  } catch (err) {
    res.status(500).json({ error: "toggle_failed", message: err.message });
  }
});

export default router;
