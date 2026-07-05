import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./config/db.js";

import leadsRouter from "./routes/leads.js";
import intakeRouter from "./routes/intake.js";
import dashboardRouter from "./routes/dashboard.js";
import copilotRouter from "./routes/copilot.js";
import messagingRouter from "./routes/messaging.js";
import reportRouter from "./routes/report.js";
import whatsappRouter from "./routes/whatsapp.js";
import { scheduleDailyReport } from "./lib/report.js";

const app = express();

// CORS: reflect the request origin so the Cloudflare Pages dashboard (and the
// public landing form, which live on other origins) are never blocked.
// This app has no cookie/session auth, so CORS is not a security boundary here
// anyway — a browser-side allow-all just prevents the "blocked by CORS policy"
// failure. (Add real auth before treating the API as private.)
app.use(cors({ origin: true }));
app.options("*", cors({ origin: true }));

app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    service: "saarathi-crm",
    channels: {
      whatsapp: process.env.CHANNEL_WHATSAPP === "true",
      sms: process.env.CHANNEL_SMS === "true",
      email: process.env.CHANNEL_EMAIL === "true",
    },
  })
);

app.use("/api/leads", leadsRouter);
app.use("/api/intake", intakeRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/copilot", copilotRouter);
app.use("/api/messaging", messagingRouter);
app.use("/api/report", reportRouter);
app.use("/api/whatsapp", whatsappRouter);

const PORT = process.env.PORT || 5000;

connectDB(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saarathi_crm").then(() => {
  app.listen(PORT, () => console.log(`\u2713 Saarathi CRM API on port ${PORT}`));
  scheduleDailyReport();
});