import { getClient, CLASSIFIER_MODEL } from "./openai.js";
import {
  LOAN_LABELS,
  URGENCY_LABELS,
  EMPLOYMENT_LABELS,
} from "./normalizePhone.js";

const SYSTEM = `You are the lead-scoring engine for Saarathi Associates, a loan brokerage in India.
You receive ONE lead's form/enquiry data and rate how likely they are to convert into a funded loan.

Rate using these signals (combine them, don't score one in isolation):
- Urgency: "immediate" is strongest, "within_month" is moderate, "exploring" is weak.
- Eligibility fit: monthly income vs requested amount. A rough sanity check is that an
  unsecured loan (personal/business) above ~20x monthly income is a stretch; secured loans
  (home/lap/gold/car) tolerate higher ticket sizes because of collateral.
- Employment: salaried = easiest to underwrite, self-employed/business = needs more docs.
- Completeness: more fields filled = more serious enquiry.
- Existing loan: an existing EMI lowers eligibility headroom but is not disqualifying.

Tiers:
- "hot": serious, eligible-looking, wants it soon. Call first.
- "warm": real interest but some friction (eligibility stretch, not urgent, thin data).
- "cold": low intent ("just exploring"), poor eligibility fit, or junk-looking data.

Rules:
- Output INDICATIVE assessment only. NEVER state the loan is approved or guarantee a rate/amount.
- suggested_product: if the requested product is a poor fit, suggest a better one
  (e.g. high ticket on low income -> suggest LAP or a smaller ticket). Otherwise echo their choice.
- reason: ONE short sentence a busy caller can read in 2 seconds.
- flags: short tags for the caller, e.g. "low eligibility", "high value", "needs income proof",
  "thin data", "existing EMI". Empty array if none.

Respond with ONLY a JSON object in this exact shape, no markdown, no prose:
{"tier":"hot|warm|cold","score":0-100,"suggested_product":"...","reason":"...","flags":["..."]}`;

function leadToText(lead) {
  const f = (v, map) => (v && map ? map[v] || v : v ?? "—");
  return [
    `Name: ${lead.name || "—"}`,
    `City: ${lead.city || "—"}`,
    `Loan type requested: ${f(lead.loanType, LOAN_LABELS)}`,
    `Amount requested: ${lead.amount != null ? "₹" + Number(lead.amount).toLocaleString("en-IN") : "—"}`,
    `Employment: ${f(lead.employmentType, EMPLOYMENT_LABELS)}`,
    `Monthly income: ${lead.monthlyIncome != null ? "₹" + Number(lead.monthlyIncome).toLocaleString("en-IN") : "—"}`,
    `Urgency: ${f(lead.urgency, URGENCY_LABELS)}`,
    `Has existing loan/EMI: ${lead.existingLoan === true ? "Yes" : lead.existingLoan === false ? "No" : "—"}`,
    `Source: ${lead.source || "—"}${lead.campaign ? " / " + lead.campaign : ""}`,
  ].join("\n");
}

function safeParse(text) {
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// Classify a single lead object (not yet saved is fine). Returns the AI fields.
export async function classifyLead(lead) {
  const client = getClient();
  const resp = await client.chat.completions.create({
    model: CLASSIFIER_MODEL,
    max_tokens: 400,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: leadToText(lead) },
    ],
  });

  const text = resp.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = safeParse(text);
  } catch {
    // fallback so a parsing hiccup never blocks intake
    parsed = { tier: "warm", score: 50, suggested_product: lead.loanType || "", reason: "Auto-scored (fallback).", flags: ["review"] };
  }

  const tier = ["hot", "warm", "cold"].includes(parsed.tier) ? parsed.tier : "warm";
  let score = Number(parsed.score);
  if (Number.isNaN(score)) score = tier === "hot" ? 80 : tier === "warm" ? 55 : 25;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    tier,
    score,
    classificationReason: String(parsed.reason || "").slice(0, 300),
    suggestedProduct: String(parsed.suggested_product || lead.loanType || ""),
    flags: Array.isArray(parsed.flags) ? parsed.flags.slice(0, 6).map(String) : [],
    classifiedAt: new Date(),
  };
}
