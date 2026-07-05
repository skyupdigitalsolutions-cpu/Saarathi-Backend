// Centralized phone normalization (India default) + helpers for bands/labels.
// Mirrors the skyup-crm normalizePhone approach: one source of truth.

export function normalizePhone(raw, defaultCountry = "91") {
  if (!raw) return "";
  let s = String(raw).trim();

  // strip everything except digits and a leading +
  s = s.replace(/[^\d+]/g, "");
  s = s.replace(/(?!^)\+/g, ""); // remove any non-leading +

  if (s.startsWith("+")) {
    return s; // already E.164-ish, trust it
  }

  // drop leading 0s (e.g. 080..., 09876...)
  s = s.replace(/^0+/, "");

  // 10-digit Indian mobile -> prefix country code
  if (s.length === 10) return `+${defaultCountry}${s}`;

  // 11/12 digits starting with country code
  if (s.length === 12 && s.startsWith(defaultCountry)) return `+${s}`;
  if (s.length === 11 && s.startsWith("0")) return `+${defaultCountry}${s.slice(1)}`;

  // fallback: just prefix +
  return `+${s}`;
}

const AMOUNT_BANDS = [
  { max: 100000, label: "< ₹1L" },
  { max: 500000, label: "₹1L–5L" },
  { max: 1000000, label: "₹5L–10L" },
  { max: 2500000, label: "₹10L–25L" },
  { max: Infinity, label: "₹25L+" },
];

export function amountBand(amount) {
  if (!amount && amount !== 0) return "";
  const n = Number(amount);
  return (AMOUNT_BANDS.find((b) => n < b.max) || AMOUNT_BANDS[AMOUNT_BANDS.length - 1]).label;
}

const INCOME_BANDS = [
  { max: 25000, label: "< ₹25k" },
  { max: 50000, label: "₹25k–50k" },
  { max: 100000, label: "₹50k–1L" },
  { max: Infinity, label: "₹1L+" },
];

export function incomeBand(income) {
  if (!income && income !== 0) return "";
  const n = Number(income);
  return (INCOME_BANDS.find((b) => n < b.max) || INCOME_BANDS[INCOME_BANDS.length - 1]).label;
}

export const LOAN_LABELS = {
  personal: "Personal Loan",
  home: "Home Loan",
  car: "Car Loan",
  business: "Business Loan",
  lap: "Loan Against Property",
  gold: "Gold Loan",
};

export const URGENCY_LABELS = {
  immediate: "Immediately",
  within_month: "Within a month",
  exploring: "Just exploring",
};

export const EMPLOYMENT_LABELS = {
  salaried: "Salaried",
  self_employed: "Self-employed",
  business_owner: "Business owner",
};
