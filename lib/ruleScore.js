// Instant, free, no-API lead scorer for bulk imports.
// Mirrors the dimensions the AI classifier uses so imported leads get a sensible
// tier/score immediately. Any lead can still be AI re-scored on demand afterwards.

const SECURED = ["home", "lap", "gold", "car"];

export function ruleScore(lead) {
  let score = 50;
  const flags = [];
  const amount = lead.amount != null ? Number(lead.amount) : null;
  const income = lead.monthlyIncome != null ? Number(lead.monthlyIncome) : null;

  // urgency
  if (lead.urgency === "immediate") score += 25;
  else if (lead.urgency === "within_month") score += 5;
  else if (lead.urgency === "exploring") score -= 20;

  // employment
  if (lead.employmentType === "salaried") score += 10;
  else if (lead.employmentType === "business_owner") score += 3;

  // eligibility: requested amount vs monthly income
  if (amount && income) {
    const ratio = amount / income;
    const secured = SECURED.includes(lead.loanType);
    if (!secured) {
      if (ratio > 20) { score -= 25; flags.push("low eligibility"); }
      else if (ratio <= 10) score += 10;
    } else if (ratio > 60) {
      score -= 10; flags.push("high ticket vs income");
    }
  }

  // existing EMI
  if (lead.existingLoan === true) { score -= 5; flags.push("existing EMI"); }

  // data completeness
  const filled = ["amount", "monthlyIncome", "loanType", "city"].filter(
    (k) => lead[k] != null && lead[k] !== ""
  ).length;
  if (filled >= 4) score += 8;
  else if (filled <= 1) { score -= 10; flags.push("thin data"); }

  // high value
  if (amount && amount >= 2500000) flags.push("high value");

  score = Math.max(0, Math.min(100, Math.round(score)));
  const tier = score >= 70 ? "hot" : score >= 45 ? "warm" : "cold";

  const reason =
    tier === "hot"
      ? "Strong fit on the basics — prioritise."
      : tier === "warm"
      ? "Worth a call; some details to verify."
      : "Low intent or weak eligibility fit.";

  return {
    tier,
    score,
    classificationReason: reason + " (rule-based)",
    suggestedProduct: lead.loanType || "",
    flags: flags.slice(0, 5),
    classifiedAt: new Date(),
  };
}
