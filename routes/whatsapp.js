import express from "express";
import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import { normalizePhone } from "../lib/normalizePhone.js";
import {
  sendWhatsAppText,
  sendWhatsAppTemplate,
  whatsappEnabled,
  whatsappConfigured,
} from "../lib/whatsapp.js";
import { WHATSAPP_TEMPLATES } from "../config/whatsappTemplates.js";
import { getSettings } from "../models/Settings.js";

const router = express.Router();
const WINDOW_MS = 24 * 60 * 60 * 1000;

// ---- status / templates ----
router.get("/status", (req, res) => {
  res.json({
    enabled: whatsappEnabled(),
    configured: whatsappConfigured(),
    provider: process.env.WHATSAPP_PROVIDER || "meta",
  });
});

router.get("/templates", (req, res) => {
  res.json({
    templates: WHATSAPP_TEMPLATES.map(({ name, label, language, params, preview }) => ({
      name, label, language, params, preview,
    })),
  });
});

// ---- auto-send automation config (which template fires per lead source) ----
router.get("/automation", async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ enabled: s.whatsappAutoEnabled, templates: s.autoTemplates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/automation", async (req, res) => {
  try {
    const s = await getSettings();
    const { enabled, templates } = req.body || {};
    if (typeof enabled === "boolean") s.whatsappAutoEnabled = enabled;
    if (templates && typeof templates === "object") {
      for (const src of ["website", "meta", "manual"]) {
        if (src in templates) s.autoTemplates[src] = String(templates[src] || "");
      }
      s.markModified("autoTemplates");
    }
    await s.save();
    res.json({ enabled: s.whatsappAutoEnabled, templates: s.autoTemplates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- conversations list (leads with any message, latest first) ----
router.get("/conversations", async (req, res) => {
  try {
    const agg = await Message.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$leadId",
          last: { $first: "$$ROOT" },
          lastInbound: { $max: { $cond: [{ $eq: ["$direction", "in"] }, "$createdAt", null] } },
          unread: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] } },
        },
      },
      { $sort: { "last.createdAt": -1 } },
      { $limit: 100 },
    ]);
    const ids = agg.map((a) => a._id).filter(Boolean);
    const leads = await Lead.find({ _id: { $in: ids } }).lean();
    const map = Object.fromEntries(leads.map((l) => [String(l._id), l]));
    const conversations = agg
      .filter((a) => map[String(a._id)])
      .map((a) => {
        const l = map[String(a._id)];
        return {
          leadId: String(a._id),
          name: l.name || "(no name)",
          phone: l.phone,
          tier: l.tier,
          status: l.status,
          lastText: a.last.body,
          lastAt: a.last.createdAt,
          lastDir: a.last.direction,
          windowOpen: a.lastInbound ? Date.now() - new Date(a.lastInbound) < WINDOW_MS : false,
        };
      });
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- thread for one lead ----
router.get("/thread/:leadId", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.leadId).lean();
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    const messages = await Message.find({ leadId: lead._id }).sort({ createdAt: 1 }).lean();
    const lastInbound = [...messages].reverse().find((m) => m.direction === "in");
    const windowOpen = lastInbound ? Date.now() - new Date(lastInbound.createdAt) < WINDOW_MS : false;
    res.json({
      lead: { id: String(lead._id), name: lead.name, phone: lead.phone, tier: lead.tier, status: lead.status },
      messages,
      windowOpen,
      lastInboundAt: lastInbound?.createdAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function resolveParam(key, lead) {
  const map = {
    name: lead.name || "there",
    city: lead.city || "",
    amount: lead.amount != null ? String(lead.amount) : "",
    loan: lead.loanType || "",
  };
  return map[key] != null ? map[key] : "";
}
function fillPreview(preview, params) {
  let i = 0;
  return String(preview || "").replace(/\{\{\d+\}\}/g, () => params[i++] ?? "");
}

// ---- send (text within 24h window, or template anytime) ----
router.post("/send", async (req, res) => {
  try {
    const { leadId, type = "text", text, templateName } = req.body;
    if (!whatsappEnabled()) {
      return res.status(423).json({ error: "channel_disabled", message: "WhatsApp channel is off. Set CHANNEL_WHATSAPP=true in .env." });
    }
    const lead = await Lead.findById(leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (!lead.phone) return res.status(400).json({ error: "Lead has no phone number" });

    let result, body, tName = "";

    if (type === "template") {
      const tpl = WHATSAPP_TEMPLATES.find((t) => t.name === templateName);
      if (!tpl) return res.status(400).json({ error: "Unknown template" });
      const params = (tpl.params || []).map((k) => resolveParam(k, lead));
      result = await sendWhatsAppTemplate(lead.phone, tpl.name, params, tpl.language);
      tName = tpl.name;
      body = fillPreview(tpl.preview, params);
    } else {
      if (!text || !text.trim()) return res.status(400).json({ error: "Message body required" });
      const lastInbound = await Message.findOne({ leadId, direction: "in" }).sort({ createdAt: -1 });
      const open = lastInbound && Date.now() - new Date(lastInbound.createdAt) < WINDOW_MS;
      if (!open) {
        return res.status(409).json({
          error: "window_closed",
          message: "Outside the 24-hour window — WhatsApp requires an approved template for the first/re-opening message.",
        });
      }
      body = text.trim();
      result = await sendWhatsAppText(lead.phone, body);
    }

    const message = await Message.create({
      leadId: lead._id,
      phone: lead.phone,
      direction: "out",
      channel: "whatsapp",
      type,
      body,
      templateName: tName,
      status: result.ok ? "sent" : "failed",
      error: result.ok ? "" : result.error,
      waMessageId: result.waMessageId || "",
    });

    if (result.ok) {
      await Lead.findByIdAndUpdate(leadId, {
        $push: { notes: { text: `[WhatsApp] ${body.slice(0, 120)}`, author: "WhatsApp" } },
      });
      return res.json({ sent: true, message });
    }
    return res.status(502).json({ sent: false, error: result.error, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Meta webhook: verification ----
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ---- Meta webhook: inbound messages + delivery/read statuses ----
router.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ack immediately so Meta doesn't retry
  try {
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        // incoming messages from leads
        for (const m of value.messages || []) {
          const phone = normalizePhone(m.from);
          const body = m.text?.body || m.button?.text || m.interactive?.list_reply?.title || `[${m.type}]`;
          let lead = await Lead.findOne({ phone });
          if (!lead) {
            lead = await Lead.create({
              phone,
              phoneRaw: m.from,
              name: value.contacts?.[0]?.profile?.name || "",
              source: "whatsapp",
              status: "new",
            });
          }
          await Message.create({
            leadId: lead._id,
            phone,
            direction: "in",
            channel: "whatsapp",
            type: m.type || "text",
            body,
            status: "delivered",
            waMessageId: m.id || "",
          });
        }

        // delivery/read receipts for our outbound messages
        for (const s of value.statuses || []) {
          if (!s.id) continue;
          await Message.updateOne(
            { waMessageId: s.id },
            { status: s.status, ...(s.errors?.[0]?.title ? { error: s.errors[0].title } : {}) }
          );
        }
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err.message);
  }
});

export default router;
