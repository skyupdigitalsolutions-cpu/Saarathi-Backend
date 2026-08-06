// lib/metaLeads.js
import crypto from "crypto";

const PAGE_ID = process.env.META_PAGE_ID || "1178126958721379"; // Sarathi Loans
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function metaConfigured() {
  return Boolean(process.env.META_PAGE_ACCESS_TOKEN);
}

// Verify Meta webhook signature
export function verifyMetaSignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  if (!signatureHeader || !rawBody) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Fetch a single lead's field_data from Graph API
export async function fetchLeadById(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set");
  const url = `${GRAPH_BASE}/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Graph API error ${res.status}`);
  }
  return data;
}

// Check if the Page is subscribed to the app's leadgen webhook
export async function checkPageSubscription() {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { subscribed: false, reason: "No page token" };
  try {
    const res = await fetch(
      `${GRAPH_BASE}/${PAGE_ID}/subscribed_apps?access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { subscribed: false, reason: data?.error?.message || "Graph API error" };
    }
    const apps = data.data || [];
    const ourApp = apps.find((a) =>
      String(a.id) === String(process.env.META_APP_ID || "1019587497446059")
    );
    const hasLeadgen = ourApp?.subscribed_fields?.includes("leadgen");
    return {
      subscribed: Boolean(hasLeadgen),
      apps: apps.map((a) => ({ id: a.id, fields: a.subscribed_fields })),
    };
  } catch (err) {
    return { subscribed: false, reason: err.message };
  }
}

// Subscribe (or re-subscribe) the Page to leadgen — call this when leads stop flowing
export async function subscribePageToApp() {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set — add it to Render env vars");
  const url = `${GRAPH_BASE}/${PAGE_ID}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    const msg = data?.error?.message || "Subscription failed";
    console.error("Meta page subscription failed:", msg);
    throw new Error(msg);
  }
  console.log(`✓ Meta Page ${PAGE_ID} subscribed to leadgen`);
  return { success: true, pageId: PAGE_ID };
}

// Auto-subscribe on startup — always re-subscribes (safe, idempotent).
// Meta accepts repeated subscriptions without error.
export async function autoSubscribeOnStartup() {
  if (!metaConfigured()) {
    console.log("Meta: META_PAGE_ACCESS_TOKEN not set — skipping page subscription.");
    return;
  }
  try {
    await subscribePageToApp();
  } catch (err) {
    console.warn("Meta auto-subscribe warning (non-fatal):", err.message);
  }
}

// Map Meta field_data -> lead body.
// Maps standard fields + fuzzy-matches custom questions to Loan Details fields.
// All Q&A stored verbatim in metaFormAnswers for the Form Answers card.
export function mapMetaFields(fieldData = [], extra = {}) {
  if (fieldData.length) {
    console.log(
      "Meta field_data:",
      fieldData.map((f) => `${f.name}=${JSON.stringify(f.values?.[0])}`).join(" | ")
    );
  }

  // Exact match for standard Meta fields
  const std = (name) => {
    const f = fieldData.find((x) => (x.name || "").toLowerCase() === name);
    return f?.values?.[0] || "";
  };

  // Fuzzy match — field name contains keyword
  const fuzzy = (...kws) => {
    for (const kw of kws) {
      const f = fieldData.find((x) =>
        (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(kw.toLowerCase().replace(/[^a-z0-9]/g, ""))
      );
      if (f?.values?.[0]) return f.values[0];
    }
    return "";
  };

  // Answer lookup — search answer text across all fields by keyword in ANSWER value
  const fuzzyAnswer = (...kws) => {
    for (const kw of kws) {
      const f = fieldData.find((x) =>
        (x.values?.[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(kw.toLowerCase().replace(/[^a-z0-9]/g, ""))
      );
      if (f?.values?.[0]) return f.values[0];
    }
    return "";
  };

  // Parse Indian amount/income ranges like "₹5_lakhs_–_₹10_lakhs", "₹75,001_–_₹1,00,000"
  // Also handles "above_₹1,00,000", "upto_5_lakhs", "below_50000"
  const parseIndianAmount = (raw) => {
    if (!raw) return null;
    // Strip prefix words: above, upto, up to, below, more than, less than, approx, around
    const s = String(raw)
      .replace(/[₹_\s]/g, "")
      .replace(/^(above|upto|upto|below|morethan|lessthan|approx|around|atleast|minimum|maximum)/i, "");
    const parseOne = (p) => {
      const lmP = p.match(/(\d+(?:\.\d+)?)\s*(?:l(?:akh)?s?|lac)/i);
      if (lmP) return parseFloat(lmP[1]) * 100000;
      const n = parseFloat(p.replace(/,/g, ""));
      return isNaN(n) ? null : n;
    };
    // Range check FIRST (before single lakh match)
    const rm = s.match(/^(.+?)[–\-]+(.+)$/);
    if (rm) {
      const lo = parseOne(rm[1]), hi = parseOne(rm[2]);
      if (lo !== null && hi !== null) return Math.round((lo + hi) / 2);
      return lo ?? hi ?? null;
    }
    // Single lakh value: "5lakhs" or "above 5 lakhs"
    return parseOne(s);
  };

  // Loan amount
  const amount = parseIndianAmount(
    fuzzy("howmuchloan", "loanamount", "loanrequire", "requiredloan", "amount", "howmuchdoyouneed", "loanneeded")
  );

  // Monthly income — also matches "what_is_your_monthly_salary", "above_₹1,00,000" style answers
  const monthlyIncomeRaw = fuzzy(
    "monthlyinhand", "monthlyincome", "inhandsalary", "monthlysalary",
    "salary", "income", "whatisyourmonthlysalary", "monthlypay", "earning"
  );
  const monthlyIncome = parseIndianAmount(monthlyIncomeRaw);

  // Loan type: explicit field → campaign name → scan all answer values for loan keywords
  const LOAN_MAP = { personal: "personal", home: "home", car: "car", auto: "car", vehicle: "car", business: "business", lap: "lap", "loan against property": "lap", property: "lap", gold: "gold" };
  const loanFieldRaw = fuzzy("loantype", "whichloan", "typeofloan", "loanrequire", "kindofloan", "loanfor");
  const campaignRaw = extra.campaign || "";
  // Also scan every answer value for loan type keywords (e.g. "personal loan" in any answer)
  const allAnswerText = fieldData.map((f) => f.values?.[0] || "").join(" ");
  const loanRaw = (loanFieldRaw || campaignRaw || allAnswerText).toLowerCase();
  const loanHit = Object.keys(LOAN_MAP).find((k) => loanRaw.includes(k));
  // Final fallback: if it's a Meta lead with no loan type detected, default to "personal"
  // (most FB lead gen campaigns for loan brokers are personal loan campaigns)
  const loanType = loanHit ? LOAN_MAP[loanHit] : (extra.campaign ? "personal" : "");

  // Employment type — matches "are_you_a_salaried_employee" (yes/no answer → salaried)
  //   and "what_is_your_company_name" → infer salaried if company present
  const empRaw = (fuzzy(
    "employmenttype", "employment", "occupation", "jobtype",
    "areyoua", "areyousalaried", "employmentstatus", "workingas"
  ) || "").toLowerCase();
  // "are you a salaried employee" → answer is "yes"/"no"
  const isSalariedQuestion = fieldData.some((x) =>
    (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes("areyouasalaried") ||
    (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes("salariedemployee")
  );
  const salariedAnswer = isSalariedQuestion
    ? (fieldData.find((x) =>
        (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes("areyouasalaried") ||
        (x.name || "").toLowerCase().replace(/[^a-z0-9]/g, "").includes("salariedemployee")
      )?.values?.[0] || "").toLowerCase()
    : "";
  const employmentType = empRaw.includes("self") ? "self_employed"
    : empRaw.includes("business") || empRaw.includes("own") ? "business_owner"
    : empRaw.includes("salar") || empRaw.includes("job") ? "salaried"
    : salariedAnswer === "yes" ? "salaried"
    : salariedAnswer === "no" ? "self_employed"
    : "";

  // Urgency — explicit field first, then infer from CIBIL/payslip signals
  const urgRaw = (fuzzy("urgency", "howsoon", "whendoyou", "timeline", "whendoyouneed", "loanurgency") || "").toLowerCase();
  const cibilChecked = fuzzy("cibil", "creditscore", "cibilscore");
  const payslipReady = fuzzy("payslip", "salarycertificate", "salaryslip");
  const urgency = urgRaw.includes("immediat") || urgRaw.includes("urgent") ? "immediate"
    : urgRaw.includes("month") || urgRaw.includes("week") ? "within_month"
    : urgRaw.includes("explor") || urgRaw.includes("check") ? "exploring"
    // Infer from engagement signals: CIBIL already checked = actively pursuing
    : (cibilChecked && (cibilChecked.toLowerCase().includes("yes") || cibilChecked.toLowerCase().includes("above"))) ? "within_month"
    // Payslip ready = prepared, serious
    : (payslipReady && payslipReady.toLowerCase().includes("yes")) ? "within_month"
    : "";

  // Existing loan — match "do_you_have_existing_emi", "existing_loan", "running_loan"
  const existingLoanRaw = fuzzy("existingemi", "existingloan", "runningloan", "currentemi", "doyouhaveemi");
  const existingLoan = existingLoanRaw
    ? existingLoanRaw.toLowerCase().includes("yes") || existingLoanRaw.toLowerCase().includes("true")
    : null;

  // All Q&A verbatim
  const prettify = (s) =>
    String(s).replace(/_/g, " ").replace(/\?/g, "").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const metaFormAnswers = fieldData
    .filter((f) => f.name && f.values?.[0] !== undefined)
    .map((f) => ({ question: prettify(f.name), answer: f.values?.[0] || "" }));

  return {
    name: std("full_name") || std("name") || fuzzy("fullname", "yourname", "name"),
    phone: std("phone_number") || std("phone") || fuzzy("phonenumber", "mobilenumber", "contactnumber", "phone"),
    email: std("email") || std("email_address") || fuzzy("emailaddress", "email"),
    city: std("city") || std("town") || fuzzy("city", "location", "yourcity"),
    campaign: extra.campaign || "",
    adName: extra.adName || "",
    adsetName: extra.adsetName || "",
    formName: extra.formName || "",
    loanType,
    amount,
    monthlyIncome,
    employmentType,
    urgency,
    existingLoan,
    metaFormAnswers,
  };
}
