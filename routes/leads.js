import express from "express";
import Lead from "../models/Lead.js";
import { classifyLead } from "../lib/classifier.js";
import { ruleScore } from "../lib/ruleScore.js";
import { autoWelcomeLead } from "../lib/autoWhatsApp.js";
import {
  normalizePhone,
  amountBand,
  incomeBand,
} from "../lib/normalizePhone.js";
import {
  normLoan,
  normEmployment,
  normUrgency,
  normStatus,
  normBool,
  numOrNull,
  rowsToCsv,
} from "../lib/csv.js";

const router = express.Router();

// shared: build a lead doc from raw input + derived bands
function buildLeadFields(body, source = "manual") {
  const phone = normalizePhone(body.phone);
  return {
    name: body.name || "",
    phone,
    phoneRaw: body.phone || "",
    email: body.email || "",
    city: body.city || "",
    address: body.address || "",
    loanType: body.loanType || "",
    amount: body.amount != null && body.amount !== "" ? Number(body.amount) : null,
    amountBand: amountBand(body.amount),
    employmentType: body.employmentType || "",
    monthlyIncome:
      body.monthlyIncome != null && body.monthlyIncome !== "" ? Number(body.monthlyIncome) : null,
    incomeBand: incomeBand(body.monthlyIncome),
    urgency: body.urgency || "",
    existingLoan: typeof body.existingLoan === "boolean" ? body.existingLoan : null,
    source,
    campaign: body.campaign || "",
    // Raw Meta form answers stored verbatim — populated for source=meta leads.
    metaFormAnswers: Array.isArray(body.metaFormAnswers) ? body.metaFormAnswers : [],
  };
}

// Create + classify a lead. Used by manual add and intake.
export async function createAndClassify(body, source) {
  const fields = buildLeadFields(body, source);

  // duplicate guard on normalized phone
  if (fields.phone) {
    const existing = await Lead.findOne({ phone: fields.phone });
    if (existing) {
      return { duplicate: true, lead: existing };
    }
  }

  let lead = await Lead.create(fields);
  // classify (best-effort: never fail the create if AI errors)
  try {
    const ai = await classifyLead(lead);
    Object.assign(lead, ai);
    await lead.save();
  } catch (err) {
    console.error("Classification failed:", err.message);
  }
  // auto-send the configured WhatsApp template (best-effort, source-based)
  const whatsapp = await autoWelcomeLead(lead);
  return { duplicate: false, lead, whatsapp };
}

// GET /api/leads  — list with filters (for the table)
router.get("/", async (req, res) => {
  try {
    const {
      tier,
      status,
      loanType,
      assignedTo,
      source,
      search,
      followUpDue,
      sortBy = "createdAt",
      order = "desc",
      page = 1,
      limit = 50,
    } = req.query;

    const q = {};
    if (tier) q.tier = tier;
    if (status) q.status = status;
    if (loanType) q.loanType = loanType;
    if (source) q.source = source;
    if (assignedTo) q.assignedTo = assignedTo === "unassigned" ? "" : assignedTo;
    if (followUpDue === "true") q.followUpAt = { $lte: new Date() };
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      q.$or = [{ name: rx }, { phone: rx }, { email: rx }, { city: rx }];
    }

    const lim = Math.min(Number(limit), 200);
    const skip = (Number(page) - 1) * lim;
    const sort = { [sortBy]: order === "asc" ? 1 : -1 };

    const [leads, total] = await Promise.all([
      Lead.find(q).sort(sort).skip(skip).limit(lim),
      Lead.countDocuments(q),
    ]);
    res.json({ leads, total, page: Number(page), limit: lim });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/import  — bulk import rows from CSV (rule-scored, no AI, deduped)
router.post("/import", async (req, res) => {
  try {
    const rows = Array.isArray(req.body.leads) ? req.body.leads : [];
    if (!rows.length) return res.json({ inserted: 0, duplicates: 0, failed: 0, total: 0 });

    let failed = 0;
    const docs = [];
    for (const r of rows) {
      try {
        const phoneRaw = r.phone || "";
        const lead = {
          name: (r.name || "").trim(),
          phone: normalizePhone(phoneRaw),
          phoneRaw,
          email: (r.email || "").toLowerCase().trim(),
          city: (r.city || "").trim(),
          loanType: normLoan(r.loanType),
          amount: numOrNull(r.amount),
          employmentType: normEmployment(r.employmentType),
          monthlyIncome: numOrNull(r.monthlyIncome),
          urgency: normUrgency(r.urgency),
          existingLoan: normBool(r.existingLoan),
          status: normStatus(r.status) || "new",
          assignedTo: (r.assignedTo || "").trim(),
          campaign: (r.campaign || "").trim(),
          source: "import",
        };
        lead.amountBand = amountBand(lead.amount);
        lead.incomeBand = incomeBand(lead.monthlyIncome);
        Object.assign(lead, ruleScore(lead)); // instant tier/score, no API
        docs.push(lead);
      } catch {
        failed++;
      }
    }

    let inserted = 0;
    let duplicates = 0;
    if (docs.length) {
      try {
        const result = await Lead.insertMany(docs, { ordered: false });
        inserted = result.length;
      } catch (err) {
        // ordered:false => partial success; tally inserted + duplicate-key errors
        inserted = err.insertedDocs?.length ?? 0;
        for (const we of err.writeErrors || []) {
          const code = we.code || we.err?.code;
          if (code === 11000) duplicates++;
          else failed++;
        }
      }
    }
    res.json({ inserted, duplicates, failed, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/export  — download matching leads as CSV (same filters as the list)
router.get("/export", async (req, res) => {
  try {
    const { tier, status, loanType, assignedTo, source, search } = req.query;
    const q = {};
    if (tier) q.tier = tier;
    if (status) q.status = status;
    if (loanType) q.loanType = loanType;
    if (source) q.source = source;
    if (assignedTo) q.assignedTo = assignedTo === "unassigned" ? "" : assignedTo;
    if (search) {
      const rx = new RegExp(String(search).trim(), "i");
      q.$or = [{ name: rx }, { phone: rx }, { email: rx }, { city: rx }];
    }

    const leads = await Lead.find(q).sort({ createdAt: -1 }).lean();
    const headers = [
      { label: "Name", get: (l) => l.name },
      { label: "Phone", get: (l) => l.phone },
      { label: "Email", get: (l) => l.email },
      { label: "City", get: (l) => l.city },
      { label: "Loan Type", get: (l) => l.loanType },
      { label: "Amount", get: (l) => l.amount },
      { label: "Employment", get: (l) => l.employmentType },
      { label: "Monthly Income", get: (l) => l.monthlyIncome },
      { label: "Urgency", get: (l) => l.urgency },
      { label: "Existing Loan", get: (l) => (l.existingLoan === true ? "Yes" : l.existingLoan === false ? "No" : "") },
      { label: "Source", get: (l) => l.source },
      { label: "Campaign", get: (l) => l.campaign },
      { label: "Tier", get: (l) => l.tier },
      { label: "Score", get: (l) => l.score },
      { label: "Status", get: (l) => l.status },
      { label: "Assigned To", get: (l) => l.assignedTo },
      { label: "Follow Up At", get: (l) => (l.followUpAt ? new Date(l.followUpAt).toISOString() : "") },
      { label: "Created At", get: (l) => (l.createdAt ? new Date(l.createdAt).toISOString() : "") },
      { label: "Reason", get: (l) => l.classificationReason },
    ];

    const csv = rowsToCsv(headers, leads);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="saarathi-leads-${stamp}.csv"`);
    res.send("\uFEFF" + csv); // BOM so Excel reads UTF-8 (₹, names) correctly
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id
router.get("/:id", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads  — manual create
router.post("/", async (req, res) => {
  try {
    const { duplicate, lead } = await createAndClassify(req.body, req.body.source || "manual");
    res.status(duplicate ? 200 : 201).json({ duplicate, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id  — edit fields (+ refresh bands)
router.patch("/:id", async (req, res) => {
  try {
    const patch = { ...req.body };
    if (patch.phone) patch.phone = normalizePhone(patch.phone);
    if ("amount" in patch) patch.amountBand = amountBand(patch.amount);
    if ("monthlyIncome" in patch) patch.incomeBand = incomeBand(patch.monthlyIncome);
    const lead = await Lead.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id/status
router.patch("/:id/status", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id/assign
router.patch("/:id/assign", async (req, res) => {
  try {
    const assignee = req.body.assignedTo === "unassigned" ? "" : req.body.assignedTo || "";
    const lead = await Lead.findByIdAndUpdate(req.params.id, { assignedTo: assignee }, { new: true });
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/notes
router.post("/:id/notes", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $push: { notes: { text: req.body.text, author: req.body.author || "Agent" } } },
      { new: true }
    );
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id/follow-up
router.patch("/:id/follow-up", async (req, res) => {
  try {
    const when = req.body.followUpAt ? new Date(req.body.followUpAt) : null;
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { followUpAt: when, followUpNote: req.body.followUpNote || "" },
      { new: true }
    );
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/reclassify
router.post("/:id/reclassify", async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ error: "Not found" });
    const ai = await classifyLead(lead);
    Object.assign(lead, ai);
    await lead.save();
    res.json(lead);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
router.delete("/:id", async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
