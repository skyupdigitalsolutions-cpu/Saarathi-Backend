import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import { getSettings } from "../models/Settings.js";
import { LOAN_LABELS } from "./normalizePhone.js";
import { WHATSAPP_TEMPLATES } from "../config/whatsappTemplates.js";
import { sendWhatsAppTemplate, whatsappEnabled, whatsappConfigured } from "./whatsapp.js";

function fillPreview(preview, params) {
  let i = 0;
  return String(preview || "").replace(/\{\{\d+\}\}/g, () => params[i++] ?? "");
}

function resolveParams(keys, lead) {
  const map = {
    name: lead.name || "there",
    loan: LOAN_LABELS[lead.loanType] || "loan",
    city: lead.city || "",
    amount: lead.amount != null ? String(lead.amount) : "",
  };
  return (keys || []).map((k) => (map[k] != null ? map[k] : ""));
}

/**
 * Auto-send the configured WhatsApp template for a freshly created lead.
 * Picks the template by lead.source (website / meta / manual). Best-effort:
 * NEVER throws — a lead must never be lost because WhatsApp failed.
 * Returns { attempted, sent, template, error }.
 */
export async function autoWelcomeLead(lead) {
  const out = { attempted: false, sent: false, template: "", error: "" };
  try {
    if (!lead || !lead.phone) return out;
    if (!whatsappEnabled() || !whatsappConfigured()) return out;

    const settings = await getSettings();
    if (!settings.whatsappAutoEnabled) return out;

    // map source -> template; unknown sources fall back to the "manual" slot
    const src = ["website", "meta", "manual"].includes(lead.source) ? lead.source : "manual";
    const templateName = settings.autoTemplates?.[src] || "";
    if (!templateName) return out; // auto-send disabled for this source

    const tpl = WHATSAPP_TEMPLATES.find((t) => t.name === templateName);
    if (!tpl) return { ...out, error: `Template "${templateName}" not found in config.` };

    out.attempted = true;
    out.template = tpl.name;
    const params = resolveParams(tpl.params, lead);
    const body = fillPreview(tpl.preview, params);
    const result = await sendWhatsAppTemplate(lead.phone, tpl.name, params, tpl.language);

    await Message.create({
      leadId: lead._id,
      phone: lead.phone,
      direction: "out",
      channel: "whatsapp",
      type: "template",
      body,
      templateName: tpl.name,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? "" : result.error,
      waMessageId: result.waMessageId || "",
    });

    out.sent = result.ok;
    if (!result.ok) out.error = result.error;
    if (result.ok) {
      await Lead.findByIdAndUpdate(lead._id, {
        $push: { notes: { text: `[WhatsApp • auto] ${body.slice(0, 120)}`, author: "WhatsApp" } },
      });
    }
  } catch (err) {
    out.error = err.message;
    console.error("autoWelcomeLead error:", err.message);
  }
  return out;
}
