import express from "express";
import cors from "cors";
import { createAndClassify } from "./leads.js";
import Lead from "../models/Lead.js";
import Message from "../models/Message.js";
import { LOAN_LABELS } from "../lib/normalizePhone.js";
import { WHATSAPP_TEMPLATES } from "../config/whatsappTemplates.js";
import {
  sendWhatsAppTemplate,
  whatsappEnabled,
  whatsappConfigured,
} from "../lib/whatsapp.js";

const router = express.Router();

// Public landing-page form posts from another origin (or file://), so allow any origin here.
const publicCors = cors({ origin: true });

function fillPreview(preview, params) {
  let i = 0;
  return String(preview || "").replace(/\{\{\d+\}\}/g, () => params[i++] ?? "");
}

// Map a Meta lead-ads field_data array -> our lead body.
// Meta sends { field_name, values: [...] }. Names depend on how the Instant Form
// questions are set up; we map common ones and keep the raw payload too.
function mapMetaFields(fieldData = []) {
  const get = (...names) => {
    for (const n of names) {
      const f = fieldData.find((x) => (x.name || "").toLowerCase() === n);
      if (f && f.values && f.values.length) return f.values[0];
    }
    return "";
  };

  const loanRaw = get("loan_type", "which_loan", "loan").toLowerCase();
  const loanMap = {
    personal: "personal",
    home: "home",
    car: "car",
    auto: "car",
    business: "business",
    lap: "lap",
    "loan against property": "lap",
    gold: "gold",
  };
  const loanType =
    Object.keys(loanMap).find((k) => loanRaw.includes(k)) ? loanMap[Object.keys(loanMap).find((k) => loanRaw.includes(k))] : "";

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
    email: get("email"),
    city: get("city", "town"),
    loanType,
    amount: numeric(get("loan_amount", "amount")),
    employmentType,
    monthlyIncome: numeric(get("monthly_income", "income")),
    urgency,
    campaign: get("campaign_name") || "",
  };
}

// GET /api/intake/meta  — webhook verification handshake
router.get("/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /api/intake/meta  — receive lead webhook
// (In production you'd call the Graph API with leadgen_id to fetch field_data.
//  This accepts either an already-resolved field_data array, or a raw lead body.)
router.post("/meta", async (req, res) => {
  try {
    // Acknowledge fast so Meta doesn't retry.
    res.sendStatus(200);

    const entries = req.body?.entry || [];
    const jobs = [];

    if (entries.length) {
      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const fd = change.value?.field_data;
          if (fd) {
            const body = mapMetaFields(fd);
            jobs.push(createAndClassify({ ...body, rawPayload: change.value }, "meta"));
          }
        }
      }
    } else if (req.body.field_data) {
      jobs.push(createAndClassify({ ...mapMetaFields(req.body.field_data) }, "meta"));
    }

    await Promise.allSettled(jobs);
  } catch (err) {
    console.error("Meta intake error:", err.message);
  }
});

// POST /api/intake/test  — simulate a Meta lead while building/demoing
router.post("/test", async (req, res) => {
  try {
    const { duplicate, lead } = await createAndClassify(req.body, "meta");
    res.status(duplicate ? 200 : 201).json({ duplicate, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intake/apply  — PUBLIC landing-page form submission.
// Creates/dedupes the lead, then fires a WhatsApp acknowledgement template.
// The lead is ALWAYS saved even if WhatsApp is off/unconfigured/fails — a form must never lose a lead.
const ACK_TEMPLATE = process.env.APPLY_ACK_TEMPLATE || "application_ack";

router.options("/apply", publicCors);
router.post("/apply", publicCors, async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ ok: false, error: "Mobile number is required." });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: "Name is required." });
    }

    const { duplicate, lead } = await createAndClassify(req.body, "website");

    // Fire-and-log the acknowledgement. Never throw out of here — the lead is already saved.
    const whatsapp = { attempted: false, sent: false };
    try {
      const tpl = WHATSAPP_TEMPLATES.find((t) => t.name === ACK_TEMPLATE);
      if (whatsappEnabled() && whatsappConfigured() && tpl && lead.phone) {
        whatsapp.attempted = true;
        const paramMap = {
          name: lead.name || "there",
          loan: LOAN_LABELS[lead.loanType] || "loan",
          city: lead.city || "",
          amount: lead.amount != null ? String(lead.amount) : "",
        };
        const params = (tpl.params || []).map((k) => paramMap[k] ?? "");
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
        whatsapp.sent = result.ok;
        if (!result.ok) whatsapp.error = result.error;
        if (result.ok) {
          await Lead.findByIdAndUpdate(lead._id, {
            $push: { notes: { text: `[WhatsApp] ${body.slice(0, 120)}`, author: "WhatsApp" } },
          });
        }
      }
    } catch (waErr) {
      whatsapp.error = waErr.message;
    }

    return res.status(duplicate ? 200 : 201).json({
      ok: true,
      duplicate,
      leadId: String(lead._id),
      whatsapp,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
