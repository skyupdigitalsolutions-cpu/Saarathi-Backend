import Lead from "../models/Lead.js";

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};

function bucket(arr) {
  return arr.reduce((acc, { _id, count }) => {
    acc[_id || "unknown"] = count;
    return acc;
  }, {});
}

// One call -> everything the dashboard and the copilot need.
export async function computeStats() {
  const [
    total,
    todayCount,
    monthCount,
    byTier,
    byStatus,
    byLoan,
    byCity,
    pipeline,
    overdue,
    trendRaw,
    byAgent,
  ] = await Promise.all([
    Lead.countDocuments({}),
    Lead.countDocuments({ createdAt: { $gte: startOfToday() } }),
    Lead.countDocuments({ createdAt: { $gte: startOfMonth() } }),
    Lead.aggregate([{ $group: { _id: "$tier", count: { $sum: 1 } } }]),
    Lead.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Lead.aggregate([{ $group: { _id: "$loanType", count: { $sum: 1 } } }]),
    Lead.aggregate([
      { $match: { city: { $ne: "" } } },
      { $group: { _id: "$city", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ]),
    // open-pipeline value = sum of requested amount for leads not closed
    Lead.aggregate([
      { $match: { status: { $nin: ["disbursed", "rejected", "lost"] }, amount: { $ne: null } } },
      { $group: { _id: null, value: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ followUpAt: { $lte: new Date() } }),
    // last 14 days trend
    Lead.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 13 * 864e5) } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Lead.aggregate([
      { $match: { assignedTo: { $ne: "" } } },
      {
        $group: {
          _id: "$assignedTo",
          assigned: { $sum: 1 },
          disbursed: { $sum: { $cond: [{ $eq: ["$status", "disbursed"] }, 1, 0] } },
        },
      },
      { $sort: { assigned: -1 } },
    ]),
  ]);

  const tier = bucket(byTier);

  // build a continuous 14-day trend (fill gaps with 0)
  const trendMap = bucket(trendRaw);
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    trend.push({ date: key, count: trendMap[key] || 0 });
  }

  return {
    kpis: {
      total,
      today: todayCount,
      month: monthCount,
      hot: tier.hot || 0,
      hotPct: total ? Math.round(((tier.hot || 0) / total) * 100) : 0,
      pipelineValue: pipeline[0]?.value || 0,
      pipelineCount: pipeline[0]?.count || 0,
      overdueFollowUps: overdue,
      disbursed: bucket(byStatus).disbursed || 0,
    },
    byTier: tier,
    byStatus: bucket(byStatus),
    byLoan: bucket(byLoan),
    topCities: byCity.map((c) => ({ city: c._id, count: c.count })),
    trend,
    byAgent: byAgent.map((a) => ({
      agent: a._id,
      assigned: a.assigned,
      disbursed: a.disbursed,
    })),
  };
}
