// Tolerant normalizers (free-text CSV values -> our enums) + CSV serialization.

export function normLoan(v) {
  const s = String(v || "").toLowerCase();
  if (!s) return "";
  if (s.includes("home")) return "home";
  if (s.includes("car") || s.includes("auto") || s.includes("vehicle")) return "car";
  if (s.includes("business")) return "business";
  if (s.includes("lap") || s.includes("property")) return "lap";
  if (s.includes("gold")) return "gold";
  if (s.includes("personal")) return "personal";
  return "";
}

export function normEmployment(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("self")) return "self_employed";
  if (s.includes("business")) return "business_owner";
  if (s.includes("salar")) return "salaried";
  return "";
}

export function normUrgency(v) {
  const s = String(v || "").toLowerCase();
  if (s.includes("immediat") || s.includes("urgent") || s.includes("asap")) return "immediate";
  if (s.includes("month")) return "within_month";
  if (s.includes("explor") || s.includes("later") || s.includes("just")) return "exploring";
  return "";
}

const STATUS_SET = ["new", "contacted", "qualified", "docs_collected", "sanctioned", "disbursed", "rejected", "lost"];
export function normStatus(v) {
  const s = String(v || "").toLowerCase().trim().replace(/\s+/g, "_");
  return STATUS_SET.includes(s) ? s : "";
}

export function normBool(v) {
  const s = String(v || "").toLowerCase().trim();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
}

export function numOrNull(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();

  // Parse a single part (handles lakh notation and plain numbers)
  const parseOne = (part) => {
    const lm = part.match(/(\d+(?:\.\d+)?)\s*(?:l(?:akh)?s?|lac)/i);
    if (lm) return parseFloat(lm[1]) * 100000;
    const n = parseFloat(part.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  };

  // Range check FIRST: "₹5_lakhs_–_₹10_lakhs", "₹75,001_–_₹1,00,000"
  const clean = s.replace(/[₹_\s]/g, "");
  const rangeSep = clean.match(/^(.+?)[–\-~]+(.+)$/);
  if (rangeSep) {
    const lo = parseOne(rangeSep[1]);
    const hi = parseOne(rangeSep[2]);
    if (lo !== null && hi !== null) return Math.round((lo + hi) / 2);
    if (lo !== null) return Math.round(lo);
    if (hi !== null) return Math.round(hi);
  }

  // Single value (lakh notation or plain)
  const result = parseOne(clean);
  return result !== null ? Math.round(result) : null;
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// headers: [{ label, get(row) }]
export function rowsToCsv(headers, rows) {
  const head = headers.map((h) => csvCell(h.label)).join(",");
  const body = rows.map((r) => headers.map((h) => csvCell(h.get(r))).join(",")).join("\n");
  return head + "\n" + body + "\n";
}
