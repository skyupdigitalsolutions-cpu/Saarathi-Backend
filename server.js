import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

import leadsRouter from "./routes/leads.js";
import intakeRouter from "./routes/intake.js";
import dashboardRouter from "./routes/dashboard.js";
import copilotRouter from "./routes/copilot.js";
import messagingRouter from "./routes/messaging.js";
import reportRouter from "./routes/report.js";
import whatsappRouter from "./routes/whatsapp.js";
import subscriptionRouter from "./routes/subscription.js";
import authRouter from "./routes/auth.js";
import metaRouter, { campaignsHandler } from "./routes/meta.js";

import { requireAuth } from "./lib/auth.js";
import { subscriptionGate } from "./lib/subscription.js";
import { scheduleDailyReport } from "./lib/report.js";
import { autoSubscribeOnStartup } from "./lib/metaLeads.js";

if (!process.env.JWT_SECRET) {
  console.warn("⚠ JWT_SECRET not set — using an insecure default. Set JWT_SECRET in .env before production.");
}

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));

// Capture raw body for Meta webhook signature verification
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get("/api/health", (req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// ── Open routes (no auth required) ─────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/subscription", subscriptionRouter);
app.use("/api/intake", intakeRouter);

// Meta Lead Ads webhook — open so campaign leads are never lost during
// a login lapse or subscription gap. Secured by verify token + signature.
app.use("/api/meta", metaRouter);

// ── Guarded routes (auth + subscription required) ──────────────────────────
const gate = subscriptionGate();

app.use("/api/leads", requireAuth, gate, leadsRouter);

// Campaigns breakdown for the Campaigns page
app.get("/api/meta/campaigns", requireAuth, gate, campaignsHandler);

app.use("/api/dashboard", requireAuth, gate, dashboardRouter);
app.use("/api/copilot", requireAuth, gate, copilotRouter);
app.use("/api/messaging", requireAuth, gate, messagingRouter);
app.use("/api/report", requireAuth, gate, reportRouter);
app.use("/api/whatsapp", requireAuth, gate, whatsappRouter);

// ── Start server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✓ MongoDB connected");

    // Seed developer admin if no users exist yet
    const { seedAdmin } = await import("./lib/auth.js");
    await seedAdmin();

    // Schedule daily report
    scheduleDailyReport();

    // Auto-subscribe Meta Page to leadgen webhook on startup.
    // Also re-subscribes on every incoming webhook call (in routes/meta.js).
    // This ensures leads always flow regardless of form changes or subscription drops.
    autoSubscribeOnStartup();

    app.listen(PORT, () =>
      console.log(`✓ Saarathi CRM API on port ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
