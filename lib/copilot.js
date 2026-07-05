import Lead from "../models/Lead.js";
import { getClient, COPILOT_MODEL } from "./openai.js";
import { computeStats } from "./stats.js";
import { classifyLead } from "./classifier.js";
import {
  normalizePhone,
  amountBand,
  incomeBand,
  LOAN_LABELS,
  URGENCY_LABELS,
  EMPLOYMENT_LABELS,
} from "./normalizePhone.js";

const STATUSES = [
  "new",
  "contacted",
  "qualified",
  "docs_collected",
  "sanctioned",
  "disbursed",
  "rejected",
  "lost",
];

function channelEnabled(channel) {
  return process.env[`CHANNEL_${channel.toUpperCase()}`] === "true";
}

// ------------------------------------------------------------------ prompt
const SYSTEM = `You are Saarathi Copilot, an assistant built into the Saarathi Associates loan CRM.
You help the CRM user (a loan agent/manager) understand and act on their leads faster.
Today's date: ${new Date().toDateString()}.

WHAT YOU DO
- Find & filter leads from plain English/Hinglish ("hot personal loan leads from today", "jo abhi tak call nahi kiye").
- Summarize a lead in 3 lines and give call-prep talking points.
- Explain why a lead was scored hot/warm/cold.
- Give a daily briefing (what to work on first).
- Answer analytics questions in plain words.
- Draft WhatsApp/SMS/email copy for a lead.
- Take actions: update status, edit fields, assign, add notes, set follow-ups, delete, re-classify, send messages.

STYLE
- Be concise and direct. Short sentences. You can use Hinglish if the user does.
- When you list leads, keep it scannable: name — loan/amount — tier — status. Mention the lead's reason if useful.
- Don't dump raw JSON at the user.

ELIGIBILITY / COMPLIANCE
- Anything about eligibility/amount/rate is INDICATIVE only. Never tell the user to promise a customer
  an approval, a guaranteed rate, or a guaranteed amount.

ACTIONS — CONFIRMATION RULES (important)
- These actions CHANGE data and need the user's explicit yes first: update_lead_status, update_lead,
  assign_lead, delete_lead, send_message. For these: first tell the user exactly what you're about to do
  and ask them to confirm. Only after they say yes, call the tool with confirmed=true.
- These are harmless and need NO confirmation — just do them: add_note, set_follow_up, reclassify_lead.
- Read tools (query_leads, get_lead, get_dashboard_stats, daily_briefing) never need confirmation.

MESSAGING
- You can always DRAFT a message. Sending is separate.
- A channel (whatsapp/sms/email) may be switched OFF. If send_message reports a channel is disabled,
  tell the user the draft is ready but that channel isn't activated yet — don't keep retrying.

Always prefer calling a tool over guessing. If you need a specific lead and only have a name, use query_leads
or get_lead with that name first.`;

// ------------------------------------------------------------------ tools (OpenAI function-calling format)
function fn(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, ...(required ? { required } : {}) },
    },
  };
}

export const tools = [
  fn(
    "query_leads",
    "Search/filter leads. Use for any 'show me / list / how many / who' request about multiple leads.",
    {
      tier: { type: "string", enum: ["hot", "warm", "cold", "unclassified"] },
      status: { type: "string", enum: STATUSES },
      loanType: { type: "string", enum: ["personal", "home", "car", "business", "lap", "gold"] },
      urgency: { type: "string", enum: ["immediate", "within_month", "exploring"] },
      employmentType: { type: "string", enum: ["salaried", "self_employed", "business_owner"] },
      city: { type: "string", description: "Matches city name (partial ok)." },
      assignedTo: { type: "string", description: "Agent name, or 'unassigned'." },
      source: { type: "string", enum: ["meta", "manual", "chatbot", "website", "import", "other"] },
      minAmount: { type: "number" },
      maxAmount: { type: "number" },
      minScore: { type: "number" },
      createdWithinDays: { type: "number", description: "e.g. 1 = today-ish, 7 = last week." },
      uncontacted: { type: "boolean", description: "true = status is still 'new' (not called yet)." },
      followUpDue: { type: "boolean", description: "true = follow-up date is today or overdue." },
      search: { type: "string", description: "Free text across name/phone/email/city." },
      sortBy: { type: "string", enum: ["createdAt", "score", "amount", "followUpAt"] },
      limit: { type: "number" },
    }
  ),
  fn(
    "get_lead",
    "Get ONE lead's full detail (for summary, call-prep, or explaining its score). Provide leadId, or a name/phone in 'query'.",
    {
      leadId: { type: "string" },
      query: { type: "string", description: "Name or phone if you don't have the id." },
    }
  ),
  fn("get_dashboard_stats", "Get aggregate numbers (counts by tier/status/loan type, pipeline value, trend, agents) for analytics questions.", {}),
  fn("daily_briefing", "Get today's snapshot: new leads today, hot leads, and overdue/today follow-ups — to tell the user what to do first.", {}),
  fn(
    "update_lead_status",
    "Change a lead's pipeline status. Needs confirmation: set confirmed=true only after the user says yes.",
    {
      leadId: { type: "string" },
      status: { type: "string", enum: STATUSES },
      confirmed: { type: "boolean" },
    },
    ["leadId", "status"]
  ),
  fn(
    "update_lead",
    "Edit lead fields (name, phone, email, city, loanType, amount, employmentType, monthlyIncome, urgency, existingLoan). Needs confirmation.",
    {
      leadId: { type: "string" },
      fields: { type: "object", description: "Only the fields to change." },
      confirmed: { type: "boolean" },
    },
    ["leadId", "fields"]
  ),
  fn(
    "assign_lead",
    "Assign a lead to an agent (or 'unassigned' to clear). Needs confirmation.",
    {
      leadId: { type: "string" },
      assignee: { type: "string" },
      confirmed: { type: "boolean" },
    },
    ["leadId", "assignee"]
  ),
  fn(
    "add_note",
    "Add a note to a lead's timeline. No confirmation needed.",
    { leadId: { type: "string" }, text: { type: "string" } },
    ["leadId", "text"]
  ),
  fn(
    "set_follow_up",
    "Set/clear a follow-up reminder on a lead. No confirmation needed. 'when' is an ISO datetime; empty string clears it.",
    {
      leadId: { type: "string" },
      when: { type: "string", description: "ISO datetime. Empty string clears it." },
      note: { type: "string" },
    },
    ["leadId", "when"]
  ),
  fn(
    "reclassify_lead",
    "Re-run the AI classifier on a lead (e.g. after editing its details). No confirmation needed.",
    { leadId: { type: "string" } },
    ["leadId"]
  ),
  fn(
    "delete_lead",
    "Permanently delete a lead. Needs confirmation: confirmed=true only after explicit yes.",
    { leadId: { type: "string" }, confirmed: { type: "boolean" } },
    ["leadId"]
  ),
  fn(
    "send_message",
    "Send a message to a lead on a channel. Needs confirmation. May fail if the channel is disabled — drafting is always allowed, sending is gated.",
    {
      leadId: { type: "string" },
      channel: { type: "string", enum: ["whatsapp", "sms", "email"] },
      body: { type: "string" },
      subject: { type: "string", description: "Email only." },
      confirmed: { type: "boolean" },
    },
    ["leadId", "channel", "body"]
  ),
];

// ------------------------------------------------------------------ helpers
const label = (v, map) => (v ? map[v] || v : "—");
const inr = (n) => (n != null ? "₹" + Number(n).toLocaleString("en-IN") : "—");

function leadSummaryRow(l) {
  return {
    id: String(l._id),
    name: l.name || "(no name)",
    phone: l.phone || "—",
    city: l.city || "—",
    loan: label(l.loanType, LOAN_LABELS),
    amount: inr(l.amount),
    tier: l.tier,
    score: l.score,
    status: l.status,
    assignedTo: l.assignedTo || "unassigned",
    urgency: label(l.urgency, URGENCY_LABELS),
    reason: l.classificationReason || "",
    followUpAt: l.followUpAt,
  };
}

async function resolveLead({ leadId, query }) {
  if (leadId) {
    const byId = await Lead.findById(leadId).catch(() => null);
    if (byId) return byId;
  }
  if (query) {
    const phone = normalizePhone(query);
    const byPhone = await Lead.findOne({ phone });
    if (byPhone) return byPhone;
    return Lead.findOne({ name: new RegExp(query.trim(), "i") }).sort({ createdAt: -1 });
  }
  return null;
}

// ------------------------------------------------------------------ tool handlers
const handlers = {
  async query_leads(a) {
    const q = {};
    if (a.tier) q.tier = a.tier;
    if (a.status) q.status = a.status;
    if (a.loanType) q.loanType = a.loanType;
    if (a.urgency) q.urgency = a.urgency;
    if (a.employmentType) q.employmentType = a.employmentType;
    if (a.source) q.source = a.source;
    if (a.city) q.city = new RegExp(a.city.trim(), "i");
    if (a.assignedTo) q.assignedTo = a.assignedTo.toLowerCase() === "unassigned" ? "" : new RegExp(a.assignedTo.trim(), "i");
    if (a.minAmount != null || a.maxAmount != null) {
      q.amount = {};
      if (a.minAmount != null) q.amount.$gte = a.minAmount;
      if (a.maxAmount != null) q.amount.$lte = a.maxAmount;
    }
    if (a.minScore != null) q.score = { $gte: a.minScore };
    if (a.createdWithinDays != null) q.createdAt = { $gte: new Date(Date.now() - a.createdWithinDays * 864e5) };
    if (a.uncontacted) q.status = "new";
    if (a.followUpDue) q.followUpAt = { $lte: new Date() };
    if (a.search) {
      const rx = new RegExp(a.search.trim(), "i");
      q.$or = [{ name: rx }, { phone: rx }, { email: rx }, { city: rx }];
    }

    const sortField = a.sortBy || "createdAt";
    const sort = sortField === "followUpAt" ? { followUpAt: 1 } : { [sortField]: -1 };
    const limit = Math.min(a.limit || 25, 100);

    const [rows, count] = await Promise.all([
      Lead.find(q).sort(sort).limit(limit),
      Lead.countDocuments(q),
    ]);
    return { matched: count, showing: rows.length, leads: rows.map(leadSummaryRow) };
  },

  async get_lead(a) {
    const l = await resolveLead(a);
    if (!l) return { error: "Lead not found." };
    return {
      id: String(l._id),
      name: l.name,
      phone: l.phone,
      email: l.email || "—",
      city: l.city || "—",
      loanType: label(l.loanType, LOAN_LABELS),
      amount: inr(l.amount),
      employment: label(l.employmentType, EMPLOYMENT_LABELS),
      monthlyIncome: inr(l.monthlyIncome),
      urgency: label(l.urgency, URGENCY_LABELS),
      existingLoan: l.existingLoan === true ? "Yes" : l.existingLoan === false ? "No" : "—",
      source: l.source,
      campaign: l.campaign || "—",
      tier: l.tier,
      score: l.score,
      classificationReason: l.classificationReason,
      suggestedProduct: label(l.suggestedProduct, LOAN_LABELS),
      flags: l.flags,
      status: l.status,
      assignedTo: l.assignedTo || "unassigned",
      followUpAt: l.followUpAt,
      followUpNote: l.followUpNote,
      notes: l.notes.map((n) => ({ text: n.text, author: n.author, at: n.createdAt })),
      createdAt: l.createdAt,
    };
  },

  async get_dashboard_stats() {
    return computeStats();
  },

  async daily_briefing() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [newToday, hot, dueFollowUps] = await Promise.all([
      Lead.find({ createdAt: { $gte: start } }).sort({ score: -1 }).limit(20),
      Lead.find({ tier: "hot", status: { $in: ["new", "contacted"] } }).sort({ score: -1 }).limit(15),
      Lead.find({ followUpAt: { $lte: new Date() } }).sort({ followUpAt: 1 }).limit(20),
    ]);
    return {
      newLeadsToday: newToday.length,
      hotOpen: hot.length,
      followUpsDue: dueFollowUps.length,
      topHot: hot.slice(0, 5).map(leadSummaryRow),
      overdue: dueFollowUps.slice(0, 5).map(leadSummaryRow),
    };
  },

  async update_lead_status(a) {
    if (!a.confirmed) return { needsConfirmation: true, message: `Confirm with the user before changing status to "${a.status}".` };
    const l = await Lead.findByIdAndUpdate(a.leadId, { status: a.status }, { new: true });
    if (!l) return { error: "Lead not found." };
    return { ok: true, name: l.name, status: l.status };
  },

  async update_lead(a) {
    if (!a.confirmed) return { needsConfirmation: true, message: "Confirm the edits with the user first." };
    const allowed = ["name", "phone", "email", "city", "loanType", "amount", "employmentType", "monthlyIncome", "urgency", "existingLoan"];
    const patch = {};
    for (const k of allowed) if (k in a.fields) patch[k] = a.fields[k];
    if (patch.phone) patch.phone = normalizePhone(patch.phone);
    if ("amount" in patch) patch.amountBand = amountBand(patch.amount);
    if ("monthlyIncome" in patch) patch.incomeBand = incomeBand(patch.monthlyIncome);
    const l = await Lead.findByIdAndUpdate(a.leadId, patch, { new: true });
    if (!l) return { error: "Lead not found." };
    return { ok: true, name: l.name, updated: Object.keys(patch) };
  },

  async assign_lead(a) {
    if (!a.confirmed) return { needsConfirmation: true, message: `Confirm assigning to "${a.assignee}" first.` };
    const assignee = a.assignee.toLowerCase() === "unassigned" ? "" : a.assignee;
    const l = await Lead.findByIdAndUpdate(a.leadId, { assignedTo: assignee }, { new: true });
    if (!l) return { error: "Lead not found." };
    return { ok: true, name: l.name, assignedTo: l.assignedTo || "unassigned" };
  },

  async add_note(a) {
    const l = await Lead.findByIdAndUpdate(
      a.leadId,
      { $push: { notes: { text: a.text, author: "Copilot" } } },
      { new: true }
    );
    if (!l) return { error: "Lead not found." };
    return { ok: true, name: l.name, noteCount: l.notes.length };
  },

  async set_follow_up(a) {
    const when = a.when ? new Date(a.when) : null;
    if (a.when && isNaN(when?.getTime())) return { error: "Could not parse the date. Pass an ISO datetime." };
    const l = await Lead.findByIdAndUpdate(
      a.leadId,
      { followUpAt: when, followUpNote: a.note || "" },
      { new: true }
    );
    if (!l) return { error: "Lead not found." };
    return { ok: true, name: l.name, followUpAt: l.followUpAt };
  },

  async reclassify_lead(a) {
    const l = await Lead.findById(a.leadId);
    if (!l) return { error: "Lead not found." };
    const ai = await classifyLead(l);
    Object.assign(l, ai);
    await l.save();
    return { ok: true, name: l.name, tier: l.tier, score: l.score, reason: l.classificationReason };
  },

  async delete_lead(a) {
    if (!a.confirmed) return { needsConfirmation: true, message: "Deletion is permanent — confirm with the user first." };
    const l = await Lead.findByIdAndDelete(a.leadId);
    if (!l) return { error: "Lead not found." };
    return { ok: true, deleted: l.name || String(l._id) };
  },

  async send_message(a) {
    if (!a.confirmed) return { needsConfirmation: true, message: `Confirm sending the ${a.channel} message first.` };
    if (!channelEnabled(a.channel)) {
      return {
        sent: false,
        channelDisabled: true,
        message: `The ${a.channel} channel is not activated yet (pending DLT/registration). The draft is ready; sending is disabled.`,
      };
    }
    const l = await Lead.findById(a.leadId);
    if (!l) return { error: "Lead not found." };
    // NOTE: real send (MSG91/email) gets wired here once the channel is live.
    await Lead.findByIdAndUpdate(a.leadId, {
      $push: { notes: { text: `[${a.channel}] sent: ${a.body.slice(0, 140)}`, author: "Copilot" } },
    });
    return { sent: true, channel: a.channel, to: l.phone || l.email };
  },
};

// ------------------------------------------------------------------ agentic loop (OpenAI tool calling)
export async function runCopilot(messages, { maxSteps = 6 } = {}) {
  const client = getClient();
  const convo = [{ role: "system", content: SYSTEM }, ...messages];
  const actions = [];

  for (let step = 0; step < maxSteps; step++) {
    const resp = await client.chat.completions.create({
      model: COPILOT_MODEL,
      max_tokens: 1500,
      temperature: 0.3,
      tools,
      messages: convo,
    });

    const msg = resp.choices[0].message;
    const calls = msg.tool_calls || [];

    // record the assistant turn (with any tool calls) so the next round has context
    convo.push({
      role: "assistant",
      content: msg.content ?? null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });

    if (!calls.length) {
      return { reply: msg.content || "", actions, messages: convo };
    }

    // run every tool call, append a tool result for each (OpenAI requires all answered)
    for (const call of calls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const handler = handlers[name];
      let result;
      try {
        result = handler ? await handler(args) : { error: `Unknown tool ${name}` };
      } catch (err) {
        result = { error: err.message };
      }
      actions.push({ tool: name, input: args, result });
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return { reply: "I ran out of steps on that one — try narrowing the request.", actions, messages: convo };
}
