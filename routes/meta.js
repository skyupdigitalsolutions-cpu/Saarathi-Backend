// routes/meta.js
import express from "express";
import Lead from "../models/Lead.js";
import { createAndClassify } from "./leads.js";
import {
  fetchLeadById,
  mapMetaFields,
  verifyMetaSignature,
  metaConfigured,
  subscribePageToApp,
  checkPageSubscription,
} from "../lib/metaLeads.js";

const router = express.Router();

// GET /api/meta/webhook — Meta verification handshake
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /api/meta/webhook — incoming lead notifications
router.post("/webhook", async (req, res) => {
  const sig = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(req.rawBody, sig)) {
    console.warn("Meta webhook: bad signature, rejecting.");
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  // Re-subscribe on every webhook call — ensures subscription never silently breaks
  // regardless of form changes, campaign edits, or server restarts.
  // This is idempotent: safe to call repeatedly, costs one lightweight API call.
  subscribePageToApp().catch((err) =>
    console.warn("Meta re-subscribe (non-fatal):", err.message)
  );

  try {
    const entries = req.body?.entry || [];
    const jobs = [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const v = change.value || {};
        const leadgenId = v.leadgen_id;
        if (leadgenId && metaConfigured()) {
          jobs.push(
            (async () => {
              try {
                const lead = await fetchLeadById(leadgenId);
                const body = mapMetaFields(lead.field_data, {
                  campaign: v.campaign_name || v.ad_name || "",
                  adName: v.ad_name || "",
                  adsetName: v.adset_name || "",
                  formName: lead.name || v.form_id ? `Form ${v.form_id}` : "",
                });
                await createAndClassify(
                  { ...body, rawPayload: { ...v, graph: lead } },
                  "meta"
                );
                console.log(`✓ Meta lead ${leadgenId} imported`);
              } catch (err) {
                console.error(`Meta lead ${leadgenId} fetch failed:`, err.message);
              }
            })()
          );
        } else if (v.field_data) {
          const body = mapMetaFields(v.field_data, {
            campaign: v.campaign_name || v.ad_name || "",
            adName: v.ad_name || "",
            adsetName: v.adset_name || "",
            formName: v.form_name || (v.form_id ? `Form ${v.form_id}` : ""),
          });
          jobs.push(createAndClassify({ ...body, rawPayload: v }, "meta"));
        } else if (leadgenId) {
          console.warn(`Meta lead ${leadgenId} received but META_PAGE_ACCESS_TOKEN is not set.`);
        }
      }
    }
    await Promise.allSettled(jobs);
  } catch (err) {
    console.error("Meta webhook processing error:", err.message);
  }
});

// POST /api/meta/test — simulate a meta lead
router.post("/test", async (req, res) => {
  try {
    const { duplicate, lead, whatsapp } = await createAndClassify(req.body, "meta");
    res.status(duplicate ? 200 : 201).json({ duplicate, lead, whatsapp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meta/status — config check (no secrets leaked)
router.get("/status", (req, res) => {
  res.json({
    verifyTokenSet: Boolean(process.env.META_VERIFY_TOKEN),
    appSecretSet: Boolean(process.env.META_APP_SECRET),
    pageTokenSet: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
    graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
  });
});

// GET /api/meta/subscription — check if page is subscribed to the app
router.get("/subscription", async (req, res) => {
  try {
    const result = await checkPageSubscription();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/meta/subscribe — re-subscribe the Page to the app (fixes lost subscriptions)
router.post("/subscribe", async (req, res) => {
  try {
    const result = await subscribePageToApp();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Campaigns breakdown — guarded (mounted separately in server.js)
export async function campaignsHandler(req, res) {
  try {
    const rows = await Lead.aggregate([
      { $match: { source: "meta" } },
      {
        $group: {
          _id: { $ifNull: ["$campaign", ""] },
          total: { $sum: 1 },
          hot: { $sum: { $cond: [{ $eq: ["$tier", "hot"] }, 1, 0] } },
          warm: { $sum: { $cond: [{ $eq: ["$tier", "warm"] }, 1, 0] } },
          cold: { $sum: { $cond: [{ $eq: ["$tier", "cold"] }, 1, 0] } },
          converted: {
            $sum: { $cond: [{ $in: ["$status", ["sanctioned", "disbursed"]] }, 1, 0] },
          },
          lastLeadAt: { $max: "$createdAt" },
        },
      },
      { $sort: { lastLeadAt: -1 } },
    ]);

    const campaigns = rows.map((r) => ({
      campaign: r._id || "(no campaign name)",
      total: r.total,
      hot: r.hot,
      warm: r.warm,
      cold: r.cold,
      converted: r.converted,
      lastLeadAt: r.lastLeadAt,
    }));

    const totalMetaLeads = campaigns.reduce((s, c) => s + c.total, 0);
    const subStatus = await checkPageSubscription().catch(() => ({ subscribed: null }));

    res.json({
      connection: {
        verifyTokenSet: Boolean(process.env.META_VERIFY_TOKEN),
        appSecretSet: Boolean(process.env.META_APP_SECRET),
        pageTokenSet: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
        graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
        webhookUrl: "/api/meta/webhook",
        live: Boolean(
          process.env.META_VERIFY_TOKEN &&
            process.env.META_APP_SECRET &&
            process.env.META_PAGE_ACCESS_TOKEN
        ),
        pageSubscribed: subStatus.subscribed,
      },
      totalMetaLeads,
      campaigns,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default router;
