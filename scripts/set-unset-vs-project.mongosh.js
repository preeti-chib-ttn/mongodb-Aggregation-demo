// $set / $unset vs $project — runnable demo on invoices collection
//
// Usage (after ./start.sh):
//   mongosh mongodb://localhost:27018/mongo_demo --file scripts/set-unset-vs-project.mongosh.js
//
// Environment:
//   INVOICE_ID=INV-00000042   sample document (default INV-00000042)
//   ORG_ID=org-alpha          used in summary example

const INVOICE_ID = process.env.INVOICE_ID || "INV-00000042";
const ORG_ID = process.env.ORG_ID || "org-alpha";

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

// ── Sample input ──────────────────────────────────────────────

section("INPUT — one invoice document");
const sample = db.invoices.findOne(
  { invoiceId: INVOICE_ID },
  {
    invoiceId: 1,
    orgId: 1,
    region: 1,
    status: 1,
    reportingPeriod: 1,
    amount: 1,
    currency: 1,
    lineItems: 1,
    metadata: 1,
    createdAt: 1,
  }
);
if (!sample) {
  print(`No invoice found for invoiceId=${INVOICE_ID}. Run ./setup.sh first.`);
  quit(1);
}
printjson(sample);
print(`(lineItems array length: ${sample.lineItems.length})`);

// ── Scenario 1: keep most fields, change a few ───────────────

section("SCENARIO 1 — Export prep: keep most fields, tweak a few");
print(`
Goal:
  • Add lineItemCount and exportBatch
  • Remove metadata (internal) and _id
  • New fields on invoices in the future should pass through unchanged
`);

subsection("BAD — $project must name every field to retain");
const badExportPrep = [
  { $match: { invoiceId: INVOICE_ID } },
  { $project: {
      lineItemCount: { $size: "$lineItems" },
      exportBatch: "INVOICE-EXPORT",
      invoiceId: 1,
      orgId: 1,
      region: 1,
      status: 1,
      reportingPeriod: 1,
      supplier: 1,
      lineItems: 1,
      taxBreakdown: 1,
      amount: 1,
      currency: 1,
      createdAt: 1,
      updatedAt: 1,
      _id: 0,
  }},
];
printjson(db.invoices.aggregate(badExportPrep).toArray()[0]);

subsection("GOOD — $set + $unset (only name what changes)");
const goodExportPrep = [
  { $match: { invoiceId: INVOICE_ID } },
  { $set: {
      lineItemCount: { $size: "$lineItems" },
      exportBatch: "INVOICE-EXPORT",
  }},
  { $unset: [ "metadata", "_id" ] },
];
const goodExportResult = db.invoices.aggregate(goodExportPrep).toArray()[0];
printjson(goodExportResult);
print("Keys in result: " + Object.keys(goodExportResult).sort().join(", "));
print("metadata removed: " + (goodExportResult.metadata === undefined));
print("lineItemCount added: " + goodExportResult.lineItemCount);

// ── Scenario 2: small API shape ─────────────────────────────

section("SCENARIO 2 — Dashboard summary: tiny output, new shape");
print(`
Goal:
  • Output only billing { period, amount, currency } + statusLabel
  • Drop supplier, lineItems, metadata, and everything else
`);

subsection("BAD — $set + $unset must list every field to drop");
const badSummary = [
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $limit: 1 },
  { $set: {
      billing: {
        period: "$reportingPeriod",
        amount: "$amount",
        currency: "$currency",
      },
      statusLabel: {
        $cond: {
          if: { $eq: ["$status", "READY"] },
          then: "Ready for export",
          else: "In progress",
        },
      },
  }},
  { $unset: [
      "_id", "invoiceId", "orgId", "region", "status", "reportingPeriod",
      "supplier", "lineItems", "taxBreakdown", "amount", "currency",
      "metadata", "createdAt", "updatedAt",
  ]},
];
printjson(db.invoices.aggregate(badSummary).toArray()[0]);

subsection("GOOD — $project whitelists only the fields you need");
const goodSummary = [
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $limit: 1 },
  { $project: {
      _id: 0,
      billing: {
        period: "$reportingPeriod",
        amount: "$amount",
        currency: "$currency",
      },
      statusLabel: {
        $cond: {
          if: { $eq: ["$status", "READY"] },
          then: "Ready for export",
          else: "In progress",
        },
      },
  }},
];
printjson(db.invoices.aggregate(goodSummary).toArray()[0]);

// ── Bonus: $unset before $group ──────────────────────────────

section("BONUS — Drop heavy fields before a blocking $group");
print("Remove lineItems + metadata before grouping — less RAM in $group stage");

const shrinkBeforeGroup = [
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
printjson(db.invoices.aggregate(shrinkBeforeGroup).toArray());

section("TAKEAWAY");
print(`  Keep most fields, change a few  →  $set + $unset  (Scenario 1)`);
print(`  Small fixed output shape         →  $project       (Scenario 2)`);
print(`  Before $group on wide docs       →  $unset heavy fields first`);
print("");
print("  Doc: SET-UNSET-VS-PROJECT.md");
