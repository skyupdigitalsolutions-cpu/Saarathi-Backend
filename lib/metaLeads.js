// lib/metaLeads.js
// Meta (Facebook/Instagram) Lead Ads integration helpers.
//
// A real Meta Lead Ads webhook does NOT send you the answers to the form.
// It sends a `leadgen_id`. You must then call the Graph API with your Page
// Access Token to fetch the actual field_data (name, phone, email, ...).
// This file does that fetch, plus verifies the webhook signature.
//
// Required env vars (add these on Render):
//   META_VERIFY_TOKEN        - a random string YOU invent; must match the value
//                              you type into the Meta webhook config screen.
//   META_APP_SECRET          - App Secret from your Meta app (Settings > Basic).
//   META_PAGE_ACCESS_TOKEN   - long-lived Page Access Token with leads_retrieval.
//   META_GRAPH_VERSION       - optional, defaults to v21.0.
//
// If META_APP_SECRET is unset, signature verification is skipped (handy while
// testing, but set it before going live).

import crypto from "crypto";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function metaConfigured() {
  return Boolean(process.env.META_PAGE_ACCESS_TOKEN);
}

// Verify the X-Hub-Signature-256 header Meta sends with each webhook POST.
// `rawBody` must be the EXACT bytes of the request body (see server.js raw hook).
// Returns true when valid, or when no secret is configured (skip mode).
export function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // skip when not configured (testing)
  if (!signatureHeader || !rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // constant-time compare
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Fetch a single lead's field_data from the Graph API using its leadgen_id.
// Returns the raw Graph response: { id, created_time, field_data: [...], ... }
export async function fetchLeadById(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set");

  const url = `${GRAPH_BASE}/${encodeURIComponent(
    leadgenId
  )}?access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `Graph API error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Map a Meta field_data array -> our lead body.
//
// Meta Instant Forms use the question text (slugified) as the field name,
// so field names vary per form. This function:
//   1. Logs all received field names to Render logs (helps debug new forms).
//   2. Uses fuzzy keyword matching so any field whose name contains a keyword
//      is matched, regardless of full question text.
//   3. Parses range values like "₹5 Lakhs – ₹10 Lakhs" into a midpoint number.
//
export function mapMetaFields(fieldData = [], extra = {}) {
  // Log all field names so you can see exactly what Meta is sending.
  if (fieldData.length) {
    console.log(
      "Meta field_data keys:",
      fieldData.map((f) => `${f.name}=${JSON.stringify(f.values?.[0])}`).join(" | ")
    );
  }

  // Fuzzy getter: finds the first field whose name contains ANY of the keywords.
  const fuzzy = (...keywords) => {
    for (const kw of keywords) {
      const f = fieldData.find((x) =>
        (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(
          kw.toLowerCase().replace(/[^a-z0-9]/g, "")
        )
      );
      if (f?.values?.length) return f.values[0];
    }
    return "";
  };

  // Exact getter (for standard Meta fields like full_name, phone_number).
  const exact = (...names) => {
    for (const n of names) {
      const f = fieldData.find((x) => (x.name || "").toLowerCase() === n);
      if (f?.values?.length) return f.values[0];
    }
    return "";
  };

  // Parse a numeric value from strings like:
  //   "₹5 Lakhs – ₹10 Lakhs"  → midpoint of 500000 and 1000000 → 750000
  //   "₹75,001 – ₹1,00,000"   → midpoint of 75001 and 100000   → 87500
  //   "500000"                 → 500000
  const parseAmount = (raw) => {
    if (!raw) return null;
    const s = String(raw).replace(/[₹,\s]/g, "");

    // Check for lakh notation: "5lakhs" → 500000
    const lakhMatch = s.match(/(\d+(?:\.\d+)?)\s*lakh/i);
    if (lakhMatch) return Math.round(parseFloat(lakhMatch[1]) * 100000);

    // Range: two numbers separated by –, -, or ~
    const rangeMatch = s.match(/(\d+(?:\.\d+)?)[–\-~]+(\d+(?:\.\d+)?)/);
    if (rangeMatch) {
      const lo = parseFloat(rangeMatch[1]);
      const hi = parseFloat(rangeMatch[2]);
      // If values look like lakhs (< 1000), scale them up
      const scale = (v) => (v < 1000 ? v * 100000 : v);
      return Math.round((scale(lo) + scale(hi)) / 2);
    }

    // Single number
    const single = s.match(/\d+/);
    if (single) {
      const v = parseInt(single[0], 10);
      return v < 1000 ? v * 100000 : v; // treat small numbers as lakhs
    }
    return null;
  };

  // ── Name ────────────────────────────────────────────────────────────────
  const name = exact("full_name", "name") || fuzzy("fullname", "name");

  // ── Phone ────────────────────────────────────────────────────────────────
  const phone =
    exact("phone_number", "phone", "mobile") ||
    fuzzy("phone", "mobile", "contact");

  // ── Email ────────────────────────────────────────────────────────────────
  const email = exact("email", "email_address") || fuzzy("email");

  // ── City ─────────────────────────────────────────────────────────────────
  const city = exact("city", "town") || fuzzy("city", "location", "town");

  // ── Loan type ─────────────────────────────────────────────────────────────
  // Matches field names like: loan_type, which_loan, type_of_loan,
  // what_type_of_loan, loan_requirement, etc.
  // Falls back to inferring from campaign name if no field present.
  const loanRaw = (
    fuzzy("loantype", "whichloan", "typeofloan", "loanrequire") ||
    extra.campaign ||
    ""
  ).toLowerCase();
  const LOAN_MAP = {
    personal: "personal",
    home: "home",
    car: "car",
    auto: "car",
    vehicle: "car",
    business: "business",
    "loan against property": "lap",
    property: "lap",
    lap: "lap",
    gold: "gold",
  };
  const loanHit = Object.keys(LOAN_MAP).find((k) => loanRaw.includes(k));
  const loanType = loanHit ? LOAN_MAP[loanHit] : "";

  // ── Loan amount ───────────────────────────────────────────────────────────
  // Matches: loan_amount, how_much_loan_do_you_require, required_loan_amount, amount, etc.
  const amountRaw =
    fuzzy("loanamount", "howmuchloan", "loanrequire", "requiredloan") ||
    fuzzy("amount");
  const amount = parseAmount(amountRaw);

  // ── Monthly income ────────────────────────────────────────────────────────
  // Matches: monthly_income, monthly_in_hand_salary, salary, income, etc.
  const incomeRaw =
    fuzzy("monthlyincome", "monthlyinhand", "inhandsalary", "salary") ||
    fuzzy("income");
  const monthlyIncome = parseAmount(incomeRaw);

  // ── Employment type ───────────────────────────────────────────────────────
  // Matches: employment_type, employment, occupation, job_type, etc.
  const empRaw = (
    fuzzy("employmenttype", "employment", "occupation", "jobtype") || ""
  ).toLowerCase();
  const employmentType = empRaw.includes("self")
    ? "self_employed"
    : empRaw.includes("business") || empRaw.includes("own")
    ? "business_owner"
    : empRaw.includes("salar") || empRaw.includes("job")
    ? "salaried"
    : "";

  // ── Urgency ───────────────────────────────────────────────────────────────
  const urgRaw = (
    fuzzy("urgency", "howsoon", "whendoyou", "timeline") || ""
  ).toLowerCase();
  const urgency = urgRaw.includes("immediat") || urgRaw.includes("urgent")
    ? "immediate"
    : urgRaw.includes("month") || urgRaw.includes("week")
    ? "within_month"
    : urgRaw.includes("explor") || urgRaw.includes("check") || urgRaw.includes("just")
    ? "exploring"
    : "";

  return {
    name,
    phone,
    email,
    city,
    loanType,
    amount,
    employmentType,
    monthlyIncome,
    urgency,
    campaign: extra.campaign || fuzzy("campaign") || "",
  };
}
