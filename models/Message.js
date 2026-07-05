import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema(
  {
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    phone: { type: String, default: "", index: true }, // normalized +91...
    direction: { type: String, enum: ["in", "out"], required: true },
    channel: { type: String, enum: ["whatsapp", "sms", "email"], default: "whatsapp" },
    type: { type: String, default: "text" }, // text | template | image | ...
    body: { type: String, default: "" },
    templateName: { type: String, default: "" },
    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "read", "failed"],
      default: "queued",
    },
    error: { type: String, default: "" },
    waMessageId: { type: String, default: "", index: true }, // provider message id (for status callbacks)
  },
  { timestamps: true }
);

export default mongoose.model("Message", MessageSchema);
