import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "./config/db.js";
import Lead from "./models/Lead.js";
import { normalizePhone, amountBand, incomeBand } from "./lib/normalizePhone.js";

const AGENTS = ["Pooja", "Ramesh", "Anjali", ""];
const CITIES = ["Bengaluru", "Mysuru", "Hubli", "Mangaluru", "Bengaluru", "Tumakuru"];

// helper to make a lead spread over the last N days
const daysAgo = (n) => new Date(Date.now() - n * 864e5 - Math.random() * 6e7);

const RAW = [
  // hot
  { name: "Suresh Kumar", phone: "9845012345", city: "Bengaluru", loanType: "personal", amount: 400000, employmentType: "salaried", monthlyIncome: 75000, urgency: "immediate", existingLoan: false, tier: "hot", score: 88, status: "contacted", assignedTo: "Pooja", reason: "Salaried, strong income vs ticket, needs it now.", flags: ["high intent"] },
  { name: "Lakshmi Narayan", phone: "9886123456", city: "Mysuru", loanType: "home", amount: 3500000, employmentType: "salaried", monthlyIncome: 120000, urgency: "immediate", existingLoan: false, tier: "hot", score: 84, status: "qualified", assignedTo: "Ramesh", reason: "Home loan, healthy income, urgent.", flags: ["high value"] },
  { name: "Imran Shaikh", phone: "9740011223", city: "Hubli", loanType: "business", amount: 1500000, employmentType: "business_owner", monthlyIncome: 200000, urgency: "immediate", existingLoan: true, tier: "hot", score: 81, status: "docs_collected", assignedTo: "Anjali", reason: "Business owner, good cash flow, urgent.", flags: ["needs income proof"] },
  { name: "Deepa Rao", phone: "9900112233", city: "Bengaluru", loanType: "car", amount: 900000, employmentType: "salaried", monthlyIncome: 95000, urgency: "immediate", existingLoan: false, tier: "hot", score: 79, status: "new", assignedTo: "", reason: "Car loan well within eligibility, urgent.", flags: [] },
  { name: "Vikram Hegde", phone: "9663344556", city: "Mangaluru", loanType: "lap", amount: 5000000, employmentType: "business_owner", monthlyIncome: 350000, urgency: "immediate", existingLoan: false, tier: "hot", score: 86, status: "sanctioned", assignedTo: "Pooja", reason: "LAP with strong income, high value.", flags: ["high value"] },

  // warm
  { name: "Anita Desai", phone: "9812233445", city: "Bengaluru", loanType: "personal", amount: 600000, employmentType: "self_employed", monthlyIncome: 55000, urgency: "within_month", existingLoan: true, tier: "warm", score: 58, status: "contacted", assignedTo: "Ramesh", reason: "Self-employed, moderate fit, existing EMI.", flags: ["existing EMI"] },
  { name: "Mohammed Ali", phone: "9745566778", city: "Hubli", loanType: "home", amount: 2500000, employmentType: "self_employed", monthlyIncome: 80000, urgency: "within_month", existingLoan: false, tier: "warm", score: 62, status: "new", assignedTo: "", reason: "Home loan, decent income, not urgent.", flags: ["needs income proof"] },
  { name: "Priya Menon", phone: "9900998877", city: "Bengaluru", loanType: "personal", amount: 300000, employmentType: "salaried", monthlyIncome: 40000, urgency: "within_month", existingLoan: false, tier: "warm", score: 60, status: "new", assignedTo: "Anjali", reason: "Salaried but smaller ticket, exploring timing.", flags: [] },
  { name: "Ganesh Pai", phone: "9632255889", city: "Mangaluru", loanType: "gold", amount: 250000, employmentType: "business_owner", monthlyIncome: 60000, urgency: "within_month", existingLoan: false, tier: "warm", score: 55, status: "contacted", assignedTo: "Pooja", reason: "Gold loan, collateral-backed, mid intent.", flags: [] },
  { name: "Rekha Joshi", phone: "9844776655", city: "Tumakuru", loanType: "car", amount: 700000, employmentType: "salaried", monthlyIncome: 50000, urgency: "within_month", existingLoan: true, tier: "warm", score: 52, status: "new", assignedTo: "", reason: "Car loan, existing EMI tightens eligibility.", flags: ["existing EMI"] },

  // cold
  { name: "Rahul Verma", phone: "9811001100", city: "Bengaluru", loanType: "personal", amount: 2500000, employmentType: "salaried", monthlyIncome: 35000, urgency: "exploring", existingLoan: true, tier: "cold", score: 22, status: "new", assignedTo: "", reason: "₹25L personal on ₹35k income — poor eligibility.", flags: ["low eligibility"] },
  { name: "Sneha Gowda", phone: "9876500011", city: "Mysuru", loanType: "home", amount: 1000000, employmentType: "self_employed", monthlyIncome: 25000, urgency: "exploring", existingLoan: false, tier: "cold", score: 28, status: "new", assignedTo: "", reason: "Just exploring, low income for ticket.", flags: ["low eligibility", "thin data"] },
  { name: "Arjun Nair", phone: "9700700700", city: "Hubli", loanType: "personal", amount: 150000, employmentType: "salaried", monthlyIncome: 30000, urgency: "exploring", existingLoan: false, tier: "cold", score: 30, status: "lost", assignedTo: "Ramesh", reason: "Low intent, only checking options.", flags: [] },
  { name: "Test User", phone: "9000000000", city: "", loanType: "", amount: null, employmentType: "", monthlyIncome: null, urgency: "exploring", existingLoan: null, tier: "cold", score: 12, status: "new", assignedTo: "", reason: "Thin/incomplete data — likely junk.", flags: ["thin data"] },

  // a spread of recent ones for the trend line + more pipeline
  { name: "Kiran Bhat", phone: "9845998877", city: "Bengaluru", loanType: "business", amount: 800000, employmentType: "business_owner", monthlyIncome: 110000, urgency: "immediate", existingLoan: false, tier: "hot", score: 77, status: "new", assignedTo: "", reason: "Business loan, solid income, urgent.", flags: [] },
  { name: "Fatima Khan", phone: "9876123400", city: "Mysuru", loanType: "personal", amount: 500000, employmentType: "salaried", monthlyIncome: 65000, urgency: "immediate", existingLoan: false, tier: "hot", score: 80, status: "contacted", assignedTo: "Anjali", reason: "Clean salaried profile, urgent.", flags: [] },
  { name: "Naveen Reddy", phone: "9900456789", city: "Bengaluru", loanType: "home", amount: 4500000, employmentType: "salaried", monthlyIncome: 150000, urgency: "within_month", existingLoan: true, tier: "warm", score: 64, status: "qualified", assignedTo: "Pooja", reason: "High-value home loan, existing EMI to check.", flags: ["high value", "existing EMI"] },
  { name: "Divya Shetty", phone: "9632178945", city: "Mangaluru", loanType: "gold", amount: 350000, employmentType: "self_employed", monthlyIncome: 45000, urgency: "immediate", existingLoan: false, tier: "warm", score: 66, status: "docs_collected", assignedTo: "Ramesh", reason: "Gold loan, collateral-backed, urgent.", flags: [] },
  { name: "Sanjay Patil", phone: "9745001122", city: "Hubli", loanType: "car", amount: 600000, employmentType: "salaried", monthlyIncome: 55000, urgency: "within_month", existingLoan: false, tier: "warm", score: 59, status: "new", assignedTo: "", reason: "Car loan within range, timing flexible.", flags: [] },
  { name: "Meena Iyer", phone: "9844112200", city: "Bengaluru", loanType: "personal", amount: 450000, employmentType: "salaried", monthlyIncome: 70000, urgency: "immediate", existingLoan: false, tier: "hot", score: 82, status: "disbursed", assignedTo: "Pooja", reason: "Closed — disbursed.", flags: [] },
  { name: "Harish Kamath", phone: "9663300112", city: "Mangaluru", loanType: "lap", amount: 3000000, employmentType: "business_owner", monthlyIncome: 180000, urgency: "within_month", existingLoan: true, tier: "warm", score: 63, status: "new", assignedTo: "", reason: "LAP, good collateral, existing EMI.", flags: ["existing EMI"] },
  { name: "Pooja Hegde", phone: "9812001230", city: "Mysuru", loanType: "personal", amount: 200000, employmentType: "salaried", monthlyIncome: 38000, urgency: "exploring", existingLoan: false, tier: "cold", score: 33, status: "new", assignedTo: "", reason: "Low intent, small ticket.", flags: [] },
  { name: "Aakash Jain", phone: "9900223344", city: "Bengaluru", loanType: "business", amount: 2000000, employmentType: "business_owner", monthlyIncome: 90000, urgency: "within_month", existingLoan: true, tier: "warm", score: 54, status: "contacted", assignedTo: "Anjali", reason: "Business loan, ticket a stretch vs income.", flags: ["low eligibility"] },
  { name: "Shilpa Nayak", phone: "9745667788", city: "Hubli", loanType: "home", amount: 1800000, employmentType: "salaried", monthlyIncome: 85000, urgency: "immediate", existingLoan: false, tier: "hot", score: 78, status: "new", assignedTo: "", reason: "Home loan, good fit, urgent.", flags: [] },
];

async function run() {
  await connectDB(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/saarathi_crm");
  await Lead.deleteMany({});
  console.log("… cleared existing leads");

  const docs = RAW.map((r, i) => {
    const created = daysAgo(Math.floor((i / RAW.length) * 14));
    // give some leads a follow-up (a few overdue)
    let followUpAt = null;
    if (["contacted", "qualified", "docs_collected"].includes(r.status)) {
      followUpAt = new Date(Date.now() + (Math.random() < 0.4 ? -1 : 1) * Math.random() * 3 * 864e5);
    }
    return {
      name: r.name,
      phone: normalizePhone(r.phone),
      phoneRaw: r.phone,
      city: r.city,
      loanType: r.loanType,
      amount: r.amount,
      amountBand: amountBand(r.amount),
      employmentType: r.employmentType,
      monthlyIncome: r.monthlyIncome,
      incomeBand: incomeBand(r.monthlyIncome),
      urgency: r.urgency,
      existingLoan: r.existingLoan,
      source: i % 4 === 0 ? "meta" : i % 4 === 1 ? "meta" : i % 4 === 2 ? "website" : "manual",
      campaign: r.source === "manual" ? "" : "Loans-Jun-Bangalore",
      tier: r.tier,
      score: r.score,
      classificationReason: r.reason,
      suggestedProduct: r.loanType,
      flags: r.flags,
      classifiedAt: created,
      status: r.status,
      assignedTo: r.assignedTo,
      followUpAt,
      notes: [{ text: "Lead captured.", author: "System", createdAt: created }],
      createdAt: created,
      updatedAt: created,
    };
  });

  await Lead.insertMany(docs);
  console.log(`✓ Seeded ${docs.length} demo leads`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
