// routes/meta.js
// Meta (Facebook/Instagram) Lead Ads webhook.
//
// FLOW (how a real campaign lead reaches the CRM):
//   1. Someone submits your Instant Form on a Facebook/Instagram ad.
//   2. Meta POSTs a webhook here containing a `leadgen_id` (NOT the answers).
//   3. We fetch the real answers from the Graph API using that id.
//   4. We create the lead (source="meta") -> fires the opening_blast WhatsApp
//      template via the shared createAndClassify() pipeline.
//
// This route is mounted BEFORE auth/subscription so campaign leads are never
// lost during a login lapse or a subscription gap. It is safe to leave public:
// the GET verify uses your secret token, and POSTs are signature-checked with
// your App Secret.

import express from "express";
import Lead from "../models/Lead.js";
import { createAndClassify } from "./leads.js";
import {
  fetchLeadById,
  mapMetaFields,
  verifyMetaSignature,
  metaConfigured,
} from "../lib/metaLeads.js";

const router = express.Router();

// GET /api/meta/webhook  — Meta's subscription verification handshake.
// Meta calls this once when you save the webhook; echo back hub.challenge.
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// POST /api/meta/webhook  — incoming lead notifications.
router.post("/webhook", async (req, res) => {
  // 1) Verify signature (uses raw body captured in server.js). If META_APP_SECRET
  //    is unset this returns true (skip mode) so you can test before full setup.
  const sig = req.get("x-hub-signature-256");
  if (!verifyMetaSignature(req.rawBody, sig)) {
    console.warn("Meta webhook: bad signature, rejecting.");
    return res.sendStatus(401);
  }

  // 2) Acknowledge FAST (Meta retries if we don't answer ~quickly). Then process.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    const jobs = [];

    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;
        const v = change.value || {};
        const leadgenId = v.leadgen_id;

        if (leadgenId && metaConfigured()) {
          // Real webhook path: fetch the answers from the Graph API.
          jobs.push(
            (async () => {
              try {
                const lead = await fetchLeadById(leadgenId);
                const body = mapMetaFields(lead.field_data, {
                  campaign: v.campaign_name || v.ad_name || "",
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
          // Fallback: some test tools embed field_data directly.
          const body = mapMetaFields(v.field_data, {
            campaign: v.campaign_name || "",
          });
          jobs.push(createAndClassify({ ...body, rawPayload: v }, "meta"));
        } else if (leadgenId) {
          console.warn(
            `Meta lead ${leadgenId} received but META_PAGE_ACCESS_TOKEN is not set — cannot fetch details.`
          );
        }
      }
    }

    await Promise.allSettled(jobs);
  } catch (err) {
    console.error("Meta webhook processing error:", err.message);
  }
});

// POST /api/meta/test  — simulate a Meta lead while building/demoing.
// Send a JSON body like { name, phone, loanType, city, amount } to create a
// source="meta" lead (fires opening_blast). No signature required.
router.post("/test", async (req, res) => {
  try {
    const { duplicate, lead, whatsapp } = await createAndClassify(
      req.body,
      "meta"
    );
    res.status(duplicate ? 200 : 201).json({ duplicate, lead, whatsapp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meta/status  — quick check that config is present (no secrets leaked).
router.get("/status", (req, res) => {
  res.json({
    verifyTokenSet: Boolean(process.env.META_VERIFY_TOKEN),
    appSecretSet: Boolean(process.env.META_APP_SECRET),
    pageTokenSet: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
    graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
  });
});

// GET /api/meta/campaigns  — per-campaign breakdown of meta-sourced leads.
// Powers the Campaigns page: connection status + a row per campaign with
// counts, tier split, and last-lead time. Requires auth+subscription (mounted
// as a guarded sub-route in server.js, see below).
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
            $sum: {
              $cond: [
                { $in: ["$status", ["sanctioned", "disbursed"]] },
                1,
                0,
              ],
            },
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

    res.json({
      connection: {
        verifyTokenSet: Boolean(process.env.META_VERIFY_TOKEN),
        appSecretSet: Boolean(process.env.META_APP_SECRET),
        pageTokenSet: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
        graphVersion: process.env.META_GRAPH_VERSION || "v21.0",
        webhookUrl: "/api/meta/webhook",
        // "live" only when we can actually fetch real campaign leads.
        live: Boolean(
          process.env.META_VERIFY_TOKEN &&
            process.env.META_APP_SECRET &&
            process.env.META_PAGE_ACCESS_TOKEN
        ),
      },
      totalMetaLeads,
      campaigns,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export default router;
