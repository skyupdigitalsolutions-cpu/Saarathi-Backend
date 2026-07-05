import Lead from "../models/Lead.js";
import { getClient, CLASSIFIER_MODEL } from "./openai.js";

const LOAN_SHORT = {
  personal: "Personal", home: "Home", car: "Car", business: "Business", lap: "LAP", gold: "Gold",
};

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const inrShort = (n) => {
  if (n == null) return "—";
  const v = Number(n);
  if (v >= 1e7) return "₹" + (v / 1e7).toFixed(v % 1e7 ? 1 : 0) + "Cr";
  if (v >= 1e5) return "₹" + (v / 1e5).toFixed(v % 1e5 ? 1 : 0) + "L";
  if (v >= 1e3) return "₹" + Math.round(v / 1e3) + "k";
  return "₹" + v.toLocaleString("en-IN");
};

function row(l) {
  return {
    id: String(l._id),
    name: l.name || "(no name)",
    phone: l.phone || "—",
    loanType: l.loanType,
    amount: l.amount,
    tier: l.tier,
    score: l.score,
    status: l.status,
    assignedTo: l.assignedTo || "",
    followUpAt: l.followUpAt,
  };
}

// ---- gather today's raw data ----
export async function gatherDailyData() {
  const start = startOfToday();
  const now = new Date();

  const [newToday, hotToCall, followUpsDue, disbursedToday, pipeline] = await Promise.all([
    Lead.find({ createdAt: { $gte: start } }).sort({ score: -1 }),
    Lead.find({ tier: "hot", status: { $in: ["new", "contacted"] } }).sort({ score: -1 }).limit(8),
    Lead.find({ followUpAt: { $lte: now } }).sort({ followUpAt: 1 }).limit(15),
    Lead.find({ status: "disbursed", updatedAt: { $gte: start } }),
    Lead.aggregate([
      { $match: { status: { $nin: ["disbursed", "rejected", "lost"] }, amount: { $ne: null } } },
      { $group: { _id: null, value: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
  ]);

  const tierSplit = newToday.reduce((a, l) => { a[l.tier] = (a[l.tier] || 0) + 1; return a; }, {});

  return {
    date: now,
    newToday,
    hotToCall,
    followUpsDue,
    disbursedToday,
    pipeline: pipeline[0] || { value: 0, count: 0 },
    tierSplit,
  };
}

// ---- AI narrative (with a safe templated fallback) ----
function fallbackNarrative(d) {
  const n = d.newToday.length;
  const hot = d.tierSplit.hot || 0;
  const due = d.followUpsDue.length;
  let s = n ? `${n} new lead${n > 1 ? "s" : ""} came in today` : "No new leads came in today";
  if (hot) s += `, ${hot} of them hot`;
  s += ". ";
  if (d.hotToCall.length) s += `${d.hotToCall.length} hot lead${d.hotToCall.length > 1 ? "s are" : " is"} waiting for a first call. `;
  if (due) s += `${due} follow-up${due > 1 ? "s are" : " is"} due — clear those first thing tomorrow. `;
  if (d.disbursedToday.length) s += `${d.disbursedToday.length} disbursed today — nice work.`;
  return s.trim();
}

async function writeNarrative(d) {
  try {
    const client = getClient();
    const compact = {
      new_leads_today: d.newToday.length,
      quality_split: d.tierSplit,
      hot_waiting_for_call: d.hotToCall.map((l) => ({ name: l.name, loan: l.loanType, amount: l.amount, score: l.score })),
      follow_ups_due: d.followUpsDue.length,
      disbursed_today: d.disbursedToday.length,
      open_pipeline_value: d.pipeline.value,
    };
    const resp = await client.chat.completions.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 220,
      temperature: 0.5,
      messages: [
        {
          role: "system",
          content:
            "You write a short end-of-day report for a loan brokerage sales team. 2-4 sentences, plain text only (no markdown, no bullet symbols, no headings). Be specific and action-oriented: how many leads came in, the quality split, what to prioritise tomorrow morning, and any overdue follow-ups to clear. Encouraging and concise. Never promise loan approvals or interest rates.",
        },
        { role: "user", content: JSON.stringify(compact) },
      ],
    });
    return resp.choices?.[0]?.message?.content?.trim() || fallbackNarrative(d);
  } catch {
    return fallbackNarrative(d);
  }
}

// ---- full report object (used by the API + Telegram) ----
export async function generateDailyReport() {
  const d = await gatherDailyData();
  const narrative = await writeNarrative(d);
  return {
    date: d.date,
    narrative,
    summary: {
      newToday: d.newToday.length,
      hot: d.tierSplit.hot || 0,
      warm: d.tierSplit.warm || 0,
      cold: d.tierSplit.cold || 0,
      followUpsDue: d.followUpsDue.length,
      pipelineValue: d.pipeline.value,
      pipelineCount: d.pipeline.count,
      disbursedToday: d.disbursedToday.length,
    },
    hotToCall: d.hotToCall.map(row),
    followUpsDue: d.followUpsDue.map(row),
  };
}

// ---- Telegram ----
export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatForTelegram(report) {
  const r = report;
  const dateStr = new Date(r.date).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
  const L = [];
  L.push(`🌅 <b>Saarathi — Daily Report</b>`);
  L.push(`<i>${esc(dateStr)}</i>`);
  L.push("");
  L.push(esc(r.narrative));
  L.push("");
  L.push(`📥 <b>New today:</b> ${r.summary.newToday}  (🔥${r.summary.hot} · 🟠${r.summary.warm} · ⚪${r.summary.cold})`);

  if (r.hotToCall.length) {
    L.push("");
    L.push(`🔥 <b>Hot — call first:</b>`);
    r.hotToCall.slice(0, 6).forEach((l) => {
      L.push(`• ${esc(l.name)} — ${LOAN_SHORT[l.loanType] || "—"} ${inrShort(l.amount)} — ${esc(l.phone)}`);
    });
  }

  if (r.followUpsDue.length) {
    L.push("");
    L.push(`⏰ <b>Follow-ups due:</b> ${r.summary.followUpsDue}`);
    r.followUpsDue.slice(0, 6).forEach((l) => {
      const when = l.followUpAt ? new Date(l.followUpAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
      L.push(`• ${esc(l.name)} — ${esc(when)}`);
    });
  }

  L.push("");
  L.push(`💰 <b>Open pipeline:</b> ${inrShort(r.summary.pipelineValue)} (${r.summary.pipelineCount} leads)`);
  if (r.summary.disbursedToday) L.push(`✅ <b>Disbursed today:</b> ${r.summary.disbursedToday}`);

  return L.join("\n");
}

export async function sendToTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { sent: false, error: "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env." };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const data = await resp.json();
    if (!data.ok) return { sent: false, error: data.description || "Telegram API rejected the message." };
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ---- optional evening auto-send (zero-dep, runs only while server is up) ----
function msUntil(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

export function scheduleDailyReport() {
  if (process.env.REPORT_AUTOSEND !== "true") return;
  if (!telegramConfigured()) {
    console.log("• Daily report auto-send is ON but Telegram isn't configured — skipping scheduler.");
    return;
  }
  const hour = Number(process.env.REPORT_HOUR || 20);
  const minute = Number(process.env.REPORT_MINUTE || 0);

  const run = async () => {
    try {
      const report = await generateDailyReport();
      const res = await sendToTelegram(formatForTelegram(report));
      console.log(res.sent ? "✓ Daily report sent to Telegram" : "✗ Daily report send failed: " + res.error);
    } catch (e) {
      console.error("Daily report job error:", e.message);
    }
    setTimeout(run, msUntil(hour, minute)); // reschedule for tomorrow
  };

  const delay = msUntil(hour, minute);
  console.log(`✓ Daily report scheduled for ${hour}:${String(minute).padStart(2, "0")} (in ~${Math.round(delay / 60000)} min)`);
  setTimeout(run, delay);
}
