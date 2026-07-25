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

// Auto-subscribe on startup — call from server.js after MongoDB connects
export async function autoSubscribeOnStartup() {
  if (!metaConfigured()) return;
  try {
    const status = await checkPageSubscription();
    if (!status.subscribed) {
      console.log("Meta page not subscribed — auto-subscribing...");
      await subscribePageToApp();
    } else {
      console.log("✓ Meta page subscription active");
    }
  } catch (err) {
    console.warn("Meta auto-subscribe warning:", err.message);
  }
}

// Map Meta field_data -> lead body (auto-captures all form answers)
export function mapMetaFields(fieldData = [], extra = {}) {
  if (fieldData.length) {
    console.log(
      "Meta field_data:",
      fieldData.map((f) => `${f.name}=${JSON.stringify(f.values?.[0])}`).join(" | ")
    );
  }
  const std = (name) => {
    const f = fieldData.find((x) => (x.name || "").toLowerCase() === name);
    return f?.values?.[0] || "";
  };
  const prettify = (s) =>
    String(s).replace(/_/g, " ").replace(/\?/g, "").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const STANDARD = new Set(["full_name", "name", "phone_number", "phone", "email", "email_address", "city", "town"]);
  const metaFormAnswers = fieldData
    .filter((f) => !STANDARD.has((f.name || "").toLowerCase()))
    .map((f) => ({ question: prettify(f.name), answer: f.values?.[0] || "" }));
  return {
    name: std("full_name") || std("name"),
    phone: std("phone_number") || std("phone"),
    email: std("email") || std("email_address"),
    city: std("city") || std("town"),
    campaign: extra.campaign || "",
    metaFormAnswers,
  };
}
