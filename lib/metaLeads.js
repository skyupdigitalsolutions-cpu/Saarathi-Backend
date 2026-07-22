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
// Returns the raw Graph response:
//   { id, created_time, field_data: [...], ad_id, ad_name, adset_id,
//     adset_name, campaign_id, campaign_name, form_id, platform }
//
// IMPORTANT: Meta does NOT include ad_name/campaign_name by default — you
// must explicitly request them via `fields=`, otherwise you only get back
// id/created_time/field_data and every lead looks campaign-less.
const LEAD_FIELDS =
  "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name," +
  "campaign_id,campaign_name,form_id,platform";

export async function fetchLeadById(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error("META_PAGE_ACCESS_TOKEN is not set");

  const url =
    `${GRAPH_BASE}/${encodeURIComponent(leadgenId)}` +
    `?fields=${encodeURIComponent(LEAD_FIELDS)}` +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `Graph API error ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Map a Meta field_data array -> our lead body.
// Meta sends [{ name, values: [...] }]. Field names depend on how the Instant
// Form questions are set up, so we match several common variants.
export function mapMetaFields(fieldData = [], extra = {}) {
  const get = (...names) => {
    for (const n of names) {
      const f = fieldData.find((x) => (x.name || "").toLowerCase() === n);
      if (f && f.values && f.values.length) return f.values[0];
    }
    return "";
  };

  const loanRaw = get("loan_type", "which_loan", "loan", "type_of_loan").toLowerCase();
  const loanKeys = {
    personal: "personal",
    home: "home",
    car: "car",
    auto: "car",
    business: "business",
    lap: "lap",
    "loan against property": "lap",
    property: "lap",
    gold: "gold",
  };
  const hitKey = Object.keys(loanKeys).find((k) => loanRaw.includes(k));
  const loanType = hitKey ? loanKeys[hitKey] : "";

  const empRaw = get("employment_type", "employment", "occupation").toLowerCase();
  const employmentType = empRaw.includes("self")
    ? "self_employed"
    : empRaw.includes("business")
    ? "business_owner"
    : empRaw.includes("salar")
    ? "salaried"
    : "";

  const urgRaw = get("urgency", "how_soon", "when").toLowerCase();
  const urgency = urgRaw.includes("immediat")
    ? "immediate"
    : urgRaw.includes("month")
    ? "within_month"
    : urgRaw.includes("explor") || urgRaw.includes("check")
    ? "exploring"
    : "";

  const numeric = (s) => {
    const m = String(s).replace(/[, ]/g, "").match(/\d+/);
    return m ? Number(m[0]) : null;
  };

  return {
    name: get("full_name", "name", "first_name"),
    phone: get("phone_number", "phone", "mobile"),
    email: get("email", "email_address"),
    city: get("city", "town"),
    loanType,
    amount: numeric(get("loan_amount", "amount")),
    employmentType,
    monthlyIncome: numeric(get("monthly_income", "income")),
    urgency,
    campaign: extra.campaign || get("campaign_name") || "",
  };
}
