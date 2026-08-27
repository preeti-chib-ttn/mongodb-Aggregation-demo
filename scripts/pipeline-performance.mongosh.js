// Pipeline performance — BAD vs GOOD patterns on invoices collection
//
// Usage (after ./start.sh):
//   mongosh mongodb://localhost:27018/mongo_demo --file scripts/pipeline-performance.mongosh.js
//
// Environment:
//   INVOICE_ID=INV-00000042
//   ORG_ID=org-alpha
//   RUN_EXPLAIN=1     print explain for optimal pipelines

const INVOICE_ID = process.env.INVOICE_ID || "INV-00000042";
const ORG_ID = process.env.ORG_ID || "org-alpha";
const RUN_EXPLAIN = process.env.RUN_EXPLAIN === "1";
const PRICE_THRESHOLD = NumberDecimal("50.00");
const AMOUNT_MIN = NumberDecimal("500.00");

function section(title) {
  print("");
  print("═".repeat(62));
  print(" " + title);
  print("═".repeat(62));
}

function subsection(title) {
  print("");
  print("── " + title + " ──");
}

function maybeExplain(label, pipeline) {
  if (!RUN_EXPLAIN) return;
  subsection("explain — " + label);
  const ex = db.invoices.explain("executionStats").aggregate(pipeline);
  const cursor = ex.stages?.find((s) => s.$cursor)?.$cursor;
  if (cursor?.queryPlanner?.winningPlan) {
    print("winningPlan: " + cursor.queryPlanner.winningPlan.stage);
    print("totalDocsExamined: " + (ex.executionStats?.totalDocsExamined ?? "n/a"));
    print("nReturned: " + (ex.executionStats?.nReturned ?? "n/a"));
  } else {
    print("(see full explain output for blocking stage details)");
  }
}

// ═══════════════════════════════════════════════════════════════
// TIP 1 — Streaming vs blocking: $match before $sort, $sort + $limit
// ═══════════════════════════════════════════════════════════════

section("TIP 1 — Stage ordering: $match early, $sort + $limit for top-K");

subsection("BAD — $sort before $match (blocking sort on too much data)");
const badSortOrder = [
  { $sort: { amount: -1 } },
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $limit: 5 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, region: 1 } },
];
print("Pipeline: $sort → $match → $limit (anti-pattern at scale)");
printjson(db.invoices.aggregate(badSortOrder).toArray());

subsection("GOOD — $match → $sort → $limit (top-K optimisation)");
const goodSortOrder = [
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $sort: { amount: -1 } },
  { $limit: 5 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, region: 1 } },
];
print("Pipeline: $match → $sort → $limit");
printjson(db.invoices.aggregate(goodSortOrder).toArray());
maybeExplain("top-K", goodSortOrder);

subsection("GOOD — $unset wide fields before blocking $group");
const groupWithShrink = [
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $unset: [ "lineItems", "metadata", "supplier" ] },
  { $group: {
      _id: "$region",
      invoiceCount: { $sum: 1 },
      totalAmount: { $sum: { $toDouble: "$amount" } },
  }},
  { $sort: { totalAmount: -1 } },
  { $limit: 5 },
];
printjson(db.invoices.aggregate(groupWithShrink).toArray());

// ═══════════════════════════════════════════════════════════════
// TIP 2 — $filter vs $unwind + $group for array transformation
// ═══════════════════════════════════════════════════════════════

section("TIP 2 — Array transform: $filter beats $unwind + $group");

const sample = db.invoices.findOne(
  { invoiceId: INVOICE_ID },
  { invoiceId: 1, lineItems: 1 }
);
if (!sample) {
  print(`No invoice ${INVOICE_ID} — run ./setup.sh first.`);
  quit(1);
}
print(`Sample invoice: ${sample.invoiceId} (${sample.lineItems.length} line items)`);

subsection("SUBOPTIMAL — $unwind → $match → $group by $_id (blocking)");
const badArrayTransform = [
  { $match: { invoiceId: INVOICE_ID } },
  { $unwind: "$lineItems" },
  { $match: { "lineItems.unitPrice": { $gt: PRICE_THRESHOLD } } },
  { $group: {
      _id: "$_id",
      invoiceId: { $first: "$invoiceId" },
      orgId: { $first: "$orgId" },
      region: { $first: "$region" },
      status: { $first: "$status" },
      amount: { $first: "$amount" },
      lineItems: { $push: "$lineItems" },
  }},
];
const badResult = db.invoices.aggregate(badArrayTransform).toArray()[0];
print(`lineItems after rebuild: ${badResult.lineItems.length}`);
printjson({ invoiceId: badResult.invoiceId, lineItems: badResult.lineItems });

subsection("OPTIMAL — $filter on lineItems (streaming, no $group)");
const goodArrayTransform = [
  { $match: { invoiceId: INVOICE_ID } },
  { $set: {
      lineItems: {
        $filter: {
          input: "$lineItems",
          as: "line",
          cond: { $gt: ["$$line.unitPrice", PRICE_THRESHOLD] },
        },
      },
  }},
];
const goodResult = db.invoices.aggregate(goodArrayTransform).toArray()[0];
print(`lineItems after filter: ${goodResult.lineItems.length}`);
printjson({ invoiceId: goodResult.invoiceId, lineItems: goodResult.lineItems });

subsection("BONUS — $sum without unwind (line total)");
const lineTotal = db.invoices.aggregate([
  { $match: { invoiceId: INVOICE_ID } },
  { $set: {
      lineItemCount: { $size: "$lineItems" },
      lineTotal: {
        $sum: {
          $map: {
            input: "$lineItems",
            as: "line",
            in: { $multiply: ["$$line.quantity", { $toDouble: "$$line.unitPrice" }] },
          },
        },
      },
  }},
  { $project: { _id: 0, invoiceId: 1, lineItemCount: 1, lineTotal: 1, amount: 1 } },
]).toArray()[0];
printjson(lineTotal);

// ═══════════════════════════════════════════════════════════════
// TIP 3 — $match early on source fields (not computed fields)
// ═══════════════════════════════════════════════════════════════

section("TIP 3 — Push $match early: source field vs computed field");

subsection("SUBOPTIMAL — $match on computed amountDisplay");
const badMatch = [
  { $match: { orgId: ORG_ID } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, amountDisplay: 1 } },
];
printjson(db.invoices.aggregate(badMatch).toArray());

subsection("OPTIMAL — $match on source amount before $set");
const goodMatch = [
  { $match: {
      orgId: ORG_ID,
      amount: { $gte: AMOUNT_MIN },
  }},
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, amountDisplay: 1 } },
];
printjson(db.invoices.aggregate(goodMatch).toArray());
maybeExplain("early match on amount", goodMatch);

subsection("PARTIAL MATCH — indexed filter before computed field");
const partialMatch = [
  { $match: {
      orgId: ORG_ID,
      status: "READY",
      reportingPeriod: { $gte: "2024-06" },
  }},
  { $set: {
      reportingLabel: { $concat: ["$region", "-", "$reportingPeriod"] },
  }},
  { $match: { reportingLabel: { $regex: /^EU-2024-/ } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, reportingLabel: 1, amount: 1 } },
];
print("Top $match shrinks cursor; second $match refines on computed label");
printjson(db.invoices.aggregate(partialMatch).toArray());

section("TAKEAWAY");
print("  1. $match → shrink → then $sort / $group (blocking)");
print("  2. Array per-document work → $filter / $map / $sum, not $unwind+$group");
print("  3. $match on indexed source fields; partial $match when computed filter needed");
print("");
print("  Doc: PIPELINE-PERFORMANCE-GUIDE.md");
print("  Explain: RUN_EXPLAIN=1 mongosh ... --file scripts/pipeline-performance.mongosh.js");
