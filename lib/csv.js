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
  const m = String(v).replace(/[^\d.]/g, "");
  return m ? Number(m) : null;
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
