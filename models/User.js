import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "developer"], default: "user" },
    // password reset
    resetTokenHash: { type: String, default: "" },
    resetTokenExpiry: { type: Date, default: null },
  },
  { timestamps: true }
);

UserSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};
UserSchema.methods.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/** Create a reset token: returns the RAW token (for the email link); stores only its hash. */
UserSchema.methods.createResetToken = function () {
  const raw = crypto.randomBytes(32).toString("hex");
  this.resetTokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  this.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  return raw;
};
UserSchema.statics.hashToken = (raw) =>
  crypto.createHash("sha256").update(raw).digest("hex");

/** Safe object to return to the client (never the hash). */
UserSchema.methods.toSafe = function () {
  return { id: this._id, name: this.name, email: this.email, role: this.role };
};

export const User = mongoose.model("User", UserSchema);
