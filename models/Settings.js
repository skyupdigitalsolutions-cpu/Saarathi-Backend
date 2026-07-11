import mongoose from "mongoose";

/**
 * Single-document app settings. Currently holds WhatsApp automation:
 * whether to auto-send on new leads, and which template per lead source.
 */
const SettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "singleton", unique: true },
    whatsappAutoEnabled: { type: Boolean, default: true },
    // template name (from config/whatsappTemplates.js) to auto-send per source.
    // empty string = don't auto-send for that source.
    autoTemplates: {
      website: { type: String, default: "application_ack" }, // filled the form already
      meta: { type: String, default: "opening_blast" },      // from a Meta lead ad -> pull to form
      manual: { type: String, default: "opening_blast" },    // added by an agent -> pull to form
    },
  },
  { timestamps: true }
);

export const Settings = mongoose.model("Settings", SettingsSchema);

export async function getSettings() {
  let s = await Settings.findOne({ key: "singleton" });
  if (!s) s = await Settings.create({ key: "singleton" });
  return s;
}
