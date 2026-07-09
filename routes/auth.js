import { Router } from "express";
import { User } from "../models/User.js";
import { signToken, requireAuth, requireDeveloper } from "../lib/auth.js";
import { sendResetEmail, mailerConfigured } from "../lib/mailer.js";

const router = Router();

/** POST /api/auth/login  { email, password } */
router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const password = String(req.body?.password || "");
    if (!email || !password)
      return res.status(400).json({ error: "missing", message: "Email and password are required." });
    const user = await User.findOne({ email });
    if (!user || !(await user.checkPassword(password)))
      return res.status(401).json({ error: "invalid", message: "Invalid email or password." });
    res.json({ token: signToken(user), user: user.toSafe() });
  } catch (err) {
    res.status(500).json({ error: "login_failed", message: err.message });
  }
});

/** GET /api/auth/me — current user from token */
router.get("/me", requireAuth, (req, res) => res.json({ user: req.user.toSafe() }));

/** POST /api/auth/change-password  { currentPassword, newPassword } */
router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: "weak", message: "New password must be at least 6 characters." });
    if (!(await req.user.checkPassword(currentPassword || "")))
      return res.status(401).json({ error: "invalid", message: "Current password is incorrect." });
    await req.user.setPassword(newPassword);
    await req.user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "change_failed", message: err.message });
  }
});

/** POST /api/auth/forgot  { email } — always 200 (don't reveal which emails exist) */
router.post("/forgot", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const user = await User.findOne({ email });
    if (user) {
      const raw = user.createResetToken();
      await user.save();
      const base = (process.env.APP_URL || process.env.CLIENT_ORIGIN || "http://localhost:5173").replace(/\/$/, "");
      const resetUrl = `${base}/reset?token=${raw}`;
      await sendResetEmail(user.email, resetUrl);
    }
    res.json({
      ok: true,
      emailConfigured: mailerConfigured(),
      message: "If that email exists, a reset link has been sent.",
    });
  } catch (err) {
    res.status(500).json({ error: "forgot_failed", message: err.message });
  }
});

/** POST /api/auth/reset  { token, password } */
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || password.length < 6)
      return res.status(400).json({ error: "bad", message: "Invalid token or password too short (min 6)." });
    const tokenHash = User.hashToken(token);
    const user = await User.findOne({ resetTokenHash: tokenHash, resetTokenExpiry: { $gt: new Date() } });
    if (!user)
      return res.status(400).json({ error: "expired", message: "This reset link is invalid or has expired." });
    await user.setPassword(password);
    user.resetTokenHash = "";
    user.resetTokenExpiry = null;
    await user.save();
    res.json({ ok: true, token: signToken(user), user: user.toSafe() });
  } catch (err) {
    res.status(500).json({ error: "reset_failed", message: err.message });
  }
});

// ---------------- developer-only user management ----------------

/** GET /api/auth/users — list all users */
router.get("/users", requireDeveloper, async (req, res) => {
  const users = await User.find().sort({ createdAt: -1 });
  res.json(users.map((u) => u.toSafe()));
});

/** POST /api/auth/users  { name, email, password, role } — create a CRM user */
router.post("/users", requireDeveloper, async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const { name, password, role } = req.body || {};
    if (!email || !password || password.length < 6)
      return res.status(400).json({ error: "bad", message: "Email and a password (min 6 chars) are required." });
    if (await User.findOne({ email }))
      return res.status(409).json({ error: "exists", message: "A user with that email already exists." });
    const user = new User({ name: name || "", email, role: role === "developer" ? "developer" : "user" });
    await user.setPassword(password);
    await user.save();
    res.json(user.toSafe());
  } catch (err) {
    res.status(500).json({ error: "create_failed", message: err.message });
  }
});

/** DELETE /api/auth/users/:id */
router.delete("/users/:id", requireDeveloper, async (req, res) => {
  try {
    if (String(req.user._id) === req.params.id)
      return res.status(400).json({ error: "self", message: "You cannot delete your own account." });
    await User.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "delete_failed", message: err.message });
  }
});

export default router;
