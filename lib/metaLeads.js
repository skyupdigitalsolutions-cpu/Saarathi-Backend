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
// KEY DESIGN DECISION: Instead of trying to pattern-match campaign-specific
// field names (fragile across different ad campaigns), we:
//   1. Extract only the 4 standard fields Meta ALWAYS sends consistently.
//   2. Store ALL raw Q&A pairs in `metaFormAnswers` so every campaign's
//      custom questions are captured and displayed automatically.
//
// This means the "Form answers" card in LeadDetail shows every question
// exactly as the lead filled it in — no hardcoding needed.
//
export function mapMetaFields(fieldData = [], extra = {}) {
  // Log all field names to Render logs so you can see what each campaign sends.
  if (fieldData.length) {
    console.log(
      "Meta field_data:",
      fieldData.map((f) => `${f.name}=${JSON.stringify(f.values?.[0])}`).join(" | ")
    );
  }

  // Exact getter for the 4 standard Meta fields (these names are fixed by Meta).
  const std = (name) => {
    const f = fieldData.find((x) => (x.name || "").toLowerCase() === name);
    return f?.values?.[0] || "";
  };

  // Build raw Q&A list from ALL fields — pretty-print the question name.
  // Converts "how_much_loan_do_you_require" → "How much loan do you require"
  const prettify = (s) =>
    String(s)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

  // Skip the 4 standard fields from the Q&A display (they're already in the
  // lead header — showing them again would be redundant).
  const STANDARD = new Set(["full_name", "name", "phone_number", "phone", "email", "email_address", "city", "town"]);
  const metaFormAnswers = fieldData
    .filter((f) => !STANDARD.has((f.name || "").toLowerCase()))
    .map((f) => ({
      question: prettify(f.name),
      answer: f.values?.[0] || "",
    }));

  return {
    // Standard identity fields — reliably named by Meta
    name: std("full_name") || std("name"),
    phone: std("phone_number") || std("phone"),
    email: std("email") || std("email_address"),
    city: std("city") || std("town"),

    // Campaign inferred from extra (from webhook payload)
    campaign: extra.campaign || "",

    // All custom form answers stored verbatim
    metaFormAnswers,
  };
}
