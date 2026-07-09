import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

const SECRET = process.env.JWT_SECRET || "sarathi-dev-secret-change-me";

if (!process.env.JWT_SECRET) {
  console.warn("⚠ JWT_SECRET not set — using an insecure default. Set JWT_SECRET in .env before production.");
}

export function signToken(user) {
  return jwt.sign({ id: user._id, role: user.role, email: user.email }, SECRET, {
    expiresIn: "30d",
  });
}

function getToken(req) {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return null;
}

/** Require any logged-in user. */
export async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: "unauthorized", message: "Please log in." });
    const payload = jwt.verify(token, SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ error: "unauthorized", message: "Session expired." });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized", message: "Invalid or expired session." });
  }
}

/** Require a developer-role account (for the /dev panel + subscription control). */
export function requireDeveloper(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== "developer")
      return res.status(403).json({ error: "forbidden", message: "Developer access only." });
    next();
  });
}

/** On first boot (no users yet) create a developer admin so login is possible. */
export async function seedAdmin() {
  const count = await User.countDocuments();
  if (count > 0) return;
  const email = (process.env.ADMIN_EMAIL || "admin@sarathi.com").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "ChangeMe@123";
  const admin = new User({ name: "Administrator", email, role: "developer" });
  await admin.setPassword(password);
  await admin.save();
  console.log("──────────────────────────────────────────────");
  console.log("  Seeded developer admin account:");
  console.log(`    email:    ${email}`);
  console.log(`    password: ${password}`);
  console.log("  ⚠ Change this password after first login.");
  console.log("──────────────────────────────────────────────");
}
