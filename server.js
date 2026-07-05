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

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
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
  app.listen(PORT, () => console.log(`✓ Saarathi CRM API on http://localhost:${PORT}`));
  scheduleDailyReport();
});
