import express from "express";
import { runCopilot } from "../lib/copilot.js";

const router = express.Router();

// POST /api/copilot  { messages: [{role, content}, ...] }
// Send the full running history each call (the model is stateless).
router.post("/", async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: "messages[] required" });

    const { reply, actions, messages: updated } = await runCopilot(messages);

    // strip tool plumbing from history we hand back to the client (keep it light);
    // the client only needs the visible turns to render + resend.
    res.json({ reply, actions });
  } catch (err) {
    console.error("Copilot error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
