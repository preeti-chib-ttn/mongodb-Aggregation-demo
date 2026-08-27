// Labelled demo documents for aggregation anti-pattern examples.
// ONE collection (invoices) — no line_items / orders / extra collections.
//
// Usage:
//   mongosh mongodb://localhost:27018/mongo_demo --file scripts/seed-demo-scenarios.mongosh.js
//
// Docker:
//   docker compose exec mongo mongosh mongo_demo --file /scripts/seed-demo-scenarios.mongosh.js
//
// Safe to re-run — upserts by invoiceId. Does not touch bulk INV-* seed data.
//
// List scenarios:
//   db.invoices.find({ demoScenario: { $exists: true } }, { invoiceId: 1, demoScenario: 1, _id: 0 })

const BASE = {
  orgId: "org-alpha",
  region: "EU",
  currency: "EUR",
  supplier: {
    supplierId: "SUP-DEMO",
    name: "Demo Supplier Ltd",
    country: "EU",
    contactEmail: "demo@supplier.example.com",
  },
  taxBreakdown: [],
  metadata: {
    sourceSystem: "DEMO",
    importBatchId: "BATCH-DEMO",
    reconciliationNotes: "Curated document for aggregation anti-pattern demos.",
    glReferences: ["GL-DEMO"],
  },
};

function doc(scenario, invoiceId, extra) {
  return {
    ...BASE,
    demoScenario: scenario,
    invoiceId,
    status: "READY",
    reportingPeriod: "2024-06",
    amount: NumberDecimal("250.00"),
    lineItems: [
      { lineId: "L1", sku: "SKU-CHEAP", description: "Cheap item", quantity: 1,
        unitPrice: NumberDecimal("12.00"), taxCode: "VAT-20" },
      { lineId: "L2", sku: "SKU-EXP", description: "Expensive item", quantity: 2,
        unitPrice: NumberDecimal("89.00"), taxCode: "VAT-20" },
      { lineId: "L3", sku: "SKU-MID", description: "Mid item", quantity: 1,
        unitPrice: NumberDecimal("45.00"), taxCode: "VAT-20" },
      { lineId: "L4", sku: "SKU-EXP2", description: "Premium item", quantity: 1,
        unitPrice: NumberDecimal("120.00"), taxCode: "VAT-20" },
    ],
    createdAt: ISODate("2024-06-15T08:00:00Z"),
    updatedAt: ISODate("2024-06-15T08:00:00Z"),
    ...extra,
  };
}

const scenarios = [
  // AP-1 / AP-2 — array filter vs unwind+group (embedded lineItems only)
  doc("AP-1", "DEMO-AP01", {
    demoNote: "4 line items: 2 above $50, 2 below — use for $filter vs $unwind+$group",
  }),

  // AP-3 — match on amount before $set (amount >= 500)
  doc("AP-3", "DEMO-AP03", {
    amount: NumberDecimal("750.00"),
    demoNote: "amount=750 — match on amount vs computed amountDisplay",
  }),

  // AP-4 — partial match before computed reportingLabel
  doc("AP-4", "DEMO-AP04", {
    region: "EU",
    reportingPeriod: "2024-08",
    demoNote: "EU + 2024-08 — partial $match then $concat label filter",
  }),

  // AP-5 — document $match before $group (READY vs PENDING)
  doc("AP-5", "DEMO-AP05-READY", {
    status: "READY",
    region: "US",
    amount: NumberDecimal("1000.00"),
    demoNote: "READY invoice — include in rollup",
  }),
  doc("AP-5", "DEMO-AP05-PENDING", {
    status: "PENDING",
    region: "US",
    amount: NumberDecimal("2000.00"),
    demoNote: "PENDING invoice — exclude with $match before $group",
  }),

  // AP-6 / AP-7 — field shaping ($set vs $project)
  doc("AP-6", "DEMO-AP06", {
    demoNote: "Standard fat doc — $set to add field vs inclusion $project",
  }),

  // AP-8 — unset wide fields before $group
  doc("AP-8", "DEMO-AP08", {
    metadata: {
      ...BASE.metadata,
      extraBlob: "x".repeat(2000),
      auditTrail: Array.from({ length: 20 }, (_, i) => `audit-event-${i}`),
    },
    demoNote: "Heavy metadata + lineItems — $unset before $group",
  }),

  // AP-9 — latest per reportingPeriod ($first not $addToSet)
  doc("AP-9", "DEMO-AP09-OLD", {
    reportingPeriod: "2024-07",
    amount: NumberDecimal("100.00"),
    updatedAt: ISODate("2024-07-01T08:00:00Z"),
    demoNote: "Oldest version for 2024-07",
  }),
  doc("AP-9", "DEMO-AP09-MID", {
    reportingPeriod: "2024-07",
    amount: NumberDecimal("200.00"),
    updatedAt: ISODate("2024-07-15T08:00:00Z"),
    demoNote: "Middle version for 2024-07",
  }),
  doc("AP-9", "DEMO-AP09-NEW", {
    reportingPeriod: "2024-07",
    amount: NumberDecimal("300.00"),
    updatedAt: ISODate("2024-07-28T08:00:00Z"),
    demoNote: "Latest version for 2024-07 — $first after $sort",
  }),

  // AP-13 — $convert with onError on dirty ERP field
  doc("AP-13", "DEMO-AP13", {
    region: "APAC",
    amount: NumberDecimal("400.00"),
    metadata: {
      ...BASE.metadata,
      amountRaw: "N/A",
    },
    demoNote: "metadata.amountRaw is dirty string — use $convert in $group",
  }),
];

db.invoices.createIndex({ demoScenario: 1 });

let upserted = 0;
for (const scenario of scenarios) {
  const result = db.invoices.replaceOne(
    { invoiceId: scenario.invoiceId },
    scenario,
    { upsert: true }
  );
  if (result.upsertedCount || result.modifiedCount) upserted++;
}

print("");
print("Demo scenarios loaded into invoices (single collection)");
print(`  documents upserted : ${upserted}`);
print(`  labelled scenarios : ${db.invoices.countDocuments({ demoScenario: { $exists: true } })}`);
print("");
print("List all:");
print('  db.invoices.find({ demoScenario: { $exists: true } }, { invoiceId: 1, demoScenario: 1, demoNote: 1, _id: 0 })');
print("");
print("Catalog: DEMO-SCENARIOS.md");
