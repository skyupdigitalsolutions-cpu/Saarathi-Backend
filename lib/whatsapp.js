// WhatsApp provider adapter.
// Providers supported: "meta" (WhatsApp Cloud API) and "msg91" (MSG91 v5 bulk API).
// Select with WHATSAPP_PROVIDER in .env. The rest of the app is provider-agnostic.

const provider = () => (process.env.WHATSAPP_PROVIDER || "meta").toLowerCase();

export function whatsappEnabled() {
  return process.env.CHANNEL_WHATSAPP === "true";
}

export function whatsappConfigured() {
  if (provider() === "meta") {
    return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  }
  if (provider() === "msg91") {
    return Boolean(process.env.MSG91_AUTH_KEY && process.env.MSG91_WA_NUMBER);
  }
  return Boolean(process.env.WHATSAPP_TOKEN); // generic/BSP
}

// stored as +919845012345 -> providers want 919845012345 (digits only, country code, no +)
function toWaNumber(phone) {
  return String(phone || "").replace(/\D/g, "");
}

/* ------------------------------------------------------------------ */
/* Meta WhatsApp Cloud API                                            */
/* ------------------------------------------------------------------ */
async function metaSend(payload) {
  const base = process.env.WHATSAPP_API_BASE || "https://graph.facebook.com/v21.0";
  const pnid = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  try {
    const resp = await fetch(`${base}/${pnid}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return { ok: false, error: data?.error?.message || `WhatsApp API error (${resp.status})` };
    }
    return { ok: true, waMessageId: data?.messages?.[0]?.id || "" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* MSG91 v5 WhatsApp bulk API                                         */
/* Docs: https://docs.msg91.com/whatsapp                              */
/* ------------------------------------------------------------------ */
const MSG91_URL =
  process.env.MSG91_WA_URL ||
  "https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";

async function msg91Post(body) {
  try {
    const resp = await fetch(MSG91_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authkey: process.env.MSG91_AUTH_KEY,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    // MSG91 can return HTTP 200 with an error payload, so check both.
    if (!resp.ok || data?.type === "error" || data?.hasError === true) {
      const msg =
        data?.message ||
        (Array.isArray(data?.errors) ? JSON.stringify(data.errors) : data?.errors) ||
        `MSG91 error (${resp.status})`;
      return { ok: false, error: msg };
    }
    return {
      ok: true,
      waMessageId: data?.request_id || data?.data?.request_id || data?.messageId || "",
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Template send — matches MSG91 "Send WhatsApp Template" (content_type: template).
// params (["Rahul", "Bangalore", ...]) fill body_1, body_2, ... in order.
async function msg91SendTemplate(phone, templateName, params, lang) {
  const to = toWaNumber(phone);
  const components = {};
  (params || []).forEach((val, i) => {
    components[`body_${i + 1}`] = { type: "text", value: String(val) };
  });
  return msg91Post({
    integrated_number: toWaNumber(process.env.MSG91_WA_NUMBER),
    content_type: "template",
    payload: {
      type: "template",
      template: {
        name: templateName,
        language: {
          code: lang || process.env.WHATSAPP_DEFAULT_LANG || "en",
          policy: "deterministic",
        },
        to_and_components: [{ to: [to], components }],
      },
      messaging_product: "whatsapp",
    },
  });
}

// Free-form session text (only valid inside the 24h window).
// NOTE: confirmed shape pending the "Send Message (once Session Started)" doc;
// this follows MSG91's v5 session-message format. Template sends above are exact.
async function msg91SendText(phone, body) {
  const to = toWaNumber(phone);
  return msg91Post({
    integrated_number: toWaNumber(process.env.MSG91_WA_NUMBER),
    content_type: "text",
    payload: {
      to,
      type: "text",
      text: { body: String(body) },
      messaging_product: "whatsapp",
    },
  });
}

/* ------------------------------------------------------------------ */
/* Public API (provider-agnostic)                                     */
/* ------------------------------------------------------------------ */
export async function sendWhatsAppText(phone, body) {
  if (!whatsappConfigured()) {
    return { ok: false, error: "WhatsApp not configured — check provider credentials in .env." };
  }
  if (provider() === "meta") {
    return metaSend({
      messaging_product: "whatsapp",
      to: toWaNumber(phone),
      type: "text",
      text: { body, preview_url: false },
    });
  }
  if (provider() === "msg91") {
    return msg91SendText(phone, body);
  }
  return { ok: false, error: `WhatsApp provider "${provider()}" is not wired yet.` };
}

export async function sendWhatsAppTemplate(phone, templateName, params = [], lang) {
  if (!whatsappConfigured()) {
    return { ok: false, error: "WhatsApp not configured — check provider credentials in .env." };
  }
  if (provider() === "meta") {
    const language = { code: lang || process.env.WHATSAPP_DEFAULT_LANG || "en" };
    const components = params.length
      ? [{ type: "body", parameters: params.map((t) => ({ type: "text", text: String(t) })) }]
      : [];
    return metaSend({
      messaging_product: "whatsapp",
      to: toWaNumber(phone),
      type: "template",
      template: { name: templateName, language, components },
    });
  }
  if (provider() === "msg91") {
    return msg91SendTemplate(phone, templateName, params, lang);
  }
  return { ok: false, error: `WhatsApp provider "${provider()}" is not wired yet.` };
}
