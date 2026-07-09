import mongoose from "mongoose";

/**
 * Single-document ("singleton") subscription record for the whole CRM.
 * There is only ever one doc, identified by key: "singleton".
 */
const SubscriptionSchema = new mongoose.Schema(
  {
    key: { type: String, default: "singleton", unique: true },
    plan: { type: String, default: "monthly" },
    enabled: { type: Boolean, default: true }, // master switch (developer kill-switch)
    startDate: { type: Date, default: () => new Date() },
    endDate: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 days
    },
    // bookkeeping so the daily Telegram alert only fires once per day
    lastAlertDate: { type: String, default: "" }, // YYYY-MM-DD of last "expiring soon" alert
    lastExpiredNotified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const Subscription = mongoose.model("Subscription", SubscriptionSchema);

/** Find the singleton, creating it (active for 30 days) on first run. */
export async function getSubscription() {
  let sub = await Subscription.findOne({ key: "singleton" });
  if (!sub) sub = await Subscription.create({ key: "singleton" });
  return sub;
}

/** Derive live status (active / locked / days left / warn) from a sub doc. */
export function computeStatus(sub) {
  const now = Date.now();
  const end = new Date(sub.endDate).getTime();
  const start = new Date(sub.startDate).getTime();
  const msLeft = end - now;
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  const expired = now > end;
  const notStarted = now < start;
  const active = sub.enabled && !expired && !notStarted;

  let reason = null;
  if (!sub.enabled) reason = "disabled";
  else if (expired) reason = "expired";
  else if (notStarted) reason = "not_started";

  return {
    plan: sub.plan,
    enabled: sub.enabled,
    startDate: sub.startDate,
    endDate: sub.endDate,
    active,
    locked: !active,
    reason,
    daysLeft: active ? daysLeft : Math.max(0, daysLeft),
    warn: active && daysLeft <= 5, // show 5-day warning
    serverTime: new Date(now),
  };
}
