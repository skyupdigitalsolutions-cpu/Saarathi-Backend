import mongoose from "mongoose";

const NoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    author: { type: String, default: "System" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const LeadSchema = new mongoose.Schema(
  {
    // --- identity ---
    name: { type: String, default: "", trim: true },
    phone: { type: String, default: "" }, // normalized (+91...) — unique index defined below
    phoneRaw: { type: String, default: "" },
    email: { type: String, default: "", trim: true, lowercase: true },
    city: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },

    // --- loan intent ---
    loanType: {
      type: String,
      enum: ["personal", "home", "car", "business", "lap", "gold", ""],
      default: "",
    },
    amount: { type: Number, default: null }, // requested amount in ₹
    amountBand: { type: String, default: "" },
    employmentType: {
      type: String,
      enum: ["salaried", "self_employed", "business_owner", ""],
      default: "",
    },
    monthlyIncome: { type: Number, default: null },
    incomeBand: { type: String, default: "" },
    urgency: {
      type: String,
      enum: ["immediate", "within_month", "exploring", ""],
      default: "",
    },
    existingLoan: { type: Boolean, default: null },

    // --- source ---
    source: {
      type: String,
      enum: ["meta", "manual", "chatbot", "website", "import", "whatsapp", "other"],
      default: "manual",
    },
    campaign: { type: String, default: "" },

    // --- AI classification ---
    tier: {
      type: String,
      enum: ["hot", "warm", "cold", "unclassified"],
      default: "unclassified",
      index: true,
    },
    score: { type: Number, default: null }, // 0-100
    classificationReason: { type: String, default: "" },
    suggestedProduct: { type: String, default: "" },
    flags: { type: [String], default: [] },
    classifiedAt: { type: Date, default: null },

    // --- pipeline ---
    status: {
      type: String,
      enum: [
        "new",
        "contacted",
        "qualified",
        "docs_collected",
        "sanctioned",
        "disbursed",
        "rejected",
        "lost",
      ],
      default: "new",
      index: true,
    },
    assignedTo: { type: String, default: "" },

    // --- workflow ---
    notes: { type: [NoteSchema], default: [] },
    followUpAt: { type: Date, default: null },
    followUpNote: { type: String, default: "" },

    rawPayload: { type: mongoose.Schema.Types.Mixed }, // original Meta/webhook body

    // Raw form answers from Meta Lead Ads — stored as-is so any campaign
    // question is captured automatically, regardless of field names.
    metaFormAnswers: {
      type: [{ question: String, answer: String }],
      default: [],
    },
  },
  { timestamps: true }
);

// Partial unique index on normalized phone (ignores blanks) — duplicate guard.
LeadSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: "string", $ne: "" } } }
);

LeadSchema.index({ createdAt: -1 });

export default mongoose.model("Lead", LeadSchema);
