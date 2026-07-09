import { getSubscription, computeStatus } from "../models/Subscription.js";

/** Developer panel guard: requires header x-dev-key === process.env.DEV_KEY. */
export function requireDevKey(req, res, next) {
  const expected = process.env.DEV_KEY || "sarathi-dev-2026";
  const given = req.get("x-dev-key") || req.query.devKey || "";
  if (given && given === expected) return next();
  return res.status(401).json({ error: "unauthorized", message: "Invalid developer key." });
}

/**
 * Gate applied to protected API routers. If the subscription is locked
 * (expired / disabled / not started), respond 423 Locked so the frontend
 * can show the lock screen. The frontend api client already tolerates 423.
 */
export function subscriptionGate() {
  return async function (req, res, next) {
    try {
      const sub = await getSubscription();
      const status = computeStatus(sub);
      if (status.locked) {
        return res.status(423).json({
          locked: true,
          reason: status.reason,
          endDate: status.endDate,
          message:
            status.reason === "disabled"
              ? "Access has been disabled by the administrator."
              : "Your subscription has expired. Please contact the developer to renew.",
        });
      }
      return next();
    } catch (err) {
      // Fail OPEN: never let a DB hiccup lock everyone out.
      console.error("subscriptionGate error:", err.message);
      return next();
    }
  };
}

// ---------------- Telegram expiry alerts ----------------

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    return r.ok;
  } catch (e) {
    console.error("Telegram alert failed:", e.message);
    return false;
  }
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** Check once and send a Telegram alert if expiring within 5 days (once/day) or just expired. */
export async function checkExpiryAndAlert() {
  try {
    const sub = await getSubscription();
    const status = computeStatus(sub);
    const today = new Date().toISOString().slice(0, 10);

    if (status.reason === "expired" && !sub.lastExpiredNotified) {
      await sendTelegram(
        `🔒 <b>Sarathi CRM — Subscription expired</b>\nThe plan expired on <b>${fmtDate(status.endDate)}</b>. The CRM is now locked until renewed.`
      );
      sub.lastExpiredNotified = true;
      await sub.save();
      return;
    }

    if (status.active && status.warn && sub.lastAlertDate !== today) {
      const days = status.daysLeft;
      await sendTelegram(
        `⚠️ <b>Sarathi CRM — Plan expiring soon</b>\nYour subscription expires in <b>${days} day${days === 1 ? "" : "s"}</b> (on ${fmtDate(status.endDate)}). Please renew to avoid interruption.`
      );
      sub.lastAlertDate = today;
      await sub.save();
    }

    // reset the "expired notified" flag once renewed back to active
    if (status.active && sub.lastExpiredNotified) {
      sub.lastExpiredNotified = false;
      await sub.save();
    }
  } catch (err) {
    console.error("checkExpiryAndAlert error:", err.message);
  }
}

/** Run the expiry check now (10s after boot) and then every 6 hours. */
export function scheduleExpiryAlerts() {
  setTimeout(checkExpiryAndAlert, 10_000);
  setInterval(checkExpiryAndAlert, 6 * 60 * 60 * 1000);
  console.log("\u2713 Subscription expiry alerts scheduled");
}
