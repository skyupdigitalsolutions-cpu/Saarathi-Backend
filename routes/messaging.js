import express from "express";
import Lead from "../models/Lead.js";

const router = express.Router();

const channelState = () => ({
  whatsapp: process.env.CHANNEL_WHATSAPP === "true",
  sms: process.env.CHANNEL_SMS === "true",
  email: process.env.CHANNEL_EMAIL === "true",
});

// GET /api/messaging/status  — which channels are live
router.get("/status", (req, res) => {
  res.json({ channels: channelState() });
});

// POST /api/messaging/send  { leadId, channel, body, subject? }
// Locked until the channel is activated. Drafting happens client-side / via copilot.
router.post("/send", async (req, res) => {
  const { leadId, channel, body, subject } = req.body;
  const state = channelState();

  if (!["whatsapp", "sms", "email"].includes(channel)) {
    return res.status(400).json({ error: "Invalid channel" });
  }
  if (!state[channel]) {
    return res.status(423).json({
      error: "channel_disabled",
      message: `The ${channel} channel is not activated yet. Enable CHANNEL_${channel.toUpperCase()} once DLT/registration is done.`,
    });
  }

  const lead = await Lead.findById(leadId);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  // TODO: when live, plug MSG91 (whatsapp/sms) or your email provider here.
  await Lead.findByIdAndUpdate(leadId, {
    $push: { notes: { text: `[${channel}] sent: ${String(body).slice(0, 140)}`, author: "Agent" } },
  });

  res.json({ sent: true, channel, to: channel === "email" ? lead.email : lead.phone });
});

// POST /api/messaging/blast  { channel, filter, body }  — bulk send (locked too)
router.post("/blast", async (req, res) => {
  const { channel } = req.body;
  const state = channelState();
  if (!state[channel]) {
    return res.status(423).json({
      error: "channel_disabled",
      message: `Bulk ${channel} is not activated yet.`,
    });
  }
  // TODO: implement filtered bulk send when live.
  res.json({ queued: 0, note: "Bulk send stub — wire provider when channel goes live." });
});

export default router;
