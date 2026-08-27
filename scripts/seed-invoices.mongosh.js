// Seed realistic invoice documents for JVM materialization / OOM demos.
//
// Usage:
//   mongosh mongodb://localhost:27017/mongo_demo scripts/seed-invoices.mongosh.js
//
// Environment (optional):
//   TOTAL=100000        — number of invoices (default 100000)
//   BATCH=5000          — bulk insert batch size
//   DROP=1              — drop collection first (default 1)
//   SKIP_IF_EXISTS=1    — skip when invoices already exist

const TOTAL = parseInt(process.env.TOTAL || "100000", 10);
const BATCH = parseInt(process.env.BATCH || "5000", 10);
const DROP = process.env.DROP !== "0";
const SKIP_IF_EXISTS = process.env.SKIP_IF_EXISTS === "1";

if (SKIP_IF_EXISTS) {
  const existing = db.invoices.countDocuments({});
  if (existing > 0) {
    print(`Skipping seed — ${existing} invoices already in the collection`);
    quit(0);
  }
}

const STATUSES = ["READY", "READY", "READY", "READY", "PENDING", "EXPORTED"];
const REGIONS = ["EU", "US", "APAC", "LATAM"];
const ORGS = ["org-alpha", "org-beta", "org-gamma", "org-delta"];

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function lineItems(invoiceIndex) {
  const count = 4 + (invoiceIndex % 7);
  const items = [];
  for (let j = 0; j < count; j++) {
    items.push({
      lineId: `LINE-${pad(invoiceIndex, 8)}-${j}`,
      sku: `SKU-${(invoiceIndex + j) % 5000}`,
      description:
        "Professional services and licensed software components for enterprise billing cycle " +
        invoiceIndex +
        " line " +
        j,
      quantity: 1 + (j % 12),
      unitPrice: NumberDecimal(((invoiceIndex % 97) + j + 1.25).toFixed(2)),
      taxCode: j % 2 === 0 ? "VAT-20" : "GST-18",
    });
  }
  return items;
}

function invoiceDoc(i) {
  const orgId = ORGS[i % ORGS.length];
  const region = REGIONS[i % REGIONS.length];
  const status = STATUSES[i % STATUSES.length];
  const amount = NumberDecimal(((i % 10000) * 1.37 + 42.5).toFixed(2));

  return {
    invoiceId: `INV-${pad(i, 8)}`,
    orgId,
    region,
    status,
    reportingPeriod: `2024-${pad((i % 12) + 1, 2)}`,
    supplier: {
      supplierId: `SUP-${i % 1000}`,
      name: `Supplier ${i % 1000} Ltd`,
      country: region,
      contactEmail: `ap-${i % 1000}@supplier.example.com`,
    },
    lineItems: lineItems(i),
    taxBreakdown: [
      { code: "VAT", rate: 0.2, amount: NumberDecimal((Number(amount) * 0.2).toFixed(2)) },
      { code: "WITHHOLDING", rate: 0.02, amount: NumberDecimal((Number(amount) * 0.02).toFixed(2)) },
    ],
    amount,
    currency: region === "US" ? "USD" : "EUR",
    metadata: {
      sourceSystem: "ERP-SAP",
      importBatchId: `BATCH-2024-${pad(Math.floor(i / 10000), 4)}`,
      reconciliationNotes:
        "Month-end accrual placeholder text used to approximate production document size. " +
        "Typical finance payloads include audit fields, GL references, and free-text notes.",
      glReferences: [`GL-${1000 + (i % 50)}`, `COST-CENTER-${200 + (i % 30)}`],
    },
    createdAt: new Date(Date.UTC(2024, i % 12, (i % 28) + 1, 8, 0, 0)),
    updatedAt: new Date(),
  };
}

if (DROP) {
  db.invoices.drop();
  print("Dropped invoices collection");
}

db.invoices.createIndex({ status: 1 });
db.invoices.createIndex({ orgId: 1, reportingPeriod: 1 });

print(`Seeding ${TOTAL} invoices in batches of ${BATCH}...`);
const started = Date.now();

let batch = [];
for (let i = 0; i < TOTAL; i++) {
  batch.push(invoiceDoc(i));

  if (batch.length >= BATCH) {
    db.invoices.insertMany(batch, { ordered: false });
    batch = [];
    if (i > 0 && i % 50000 === 0) {
      print(`Inserted ${i + 1} / ${TOTAL}`);
    }
  }
}

if (batch.length > 0) {
  db.invoices.insertMany(batch, { ordered: false });
}

const readyCount = db.invoices.countDocuments({ status: "READY" });
const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);

print("");
print("Seed complete");
print(`  total documents : ${db.invoices.countDocuments({})}`);
print(`  status=READY    : ${readyCount} (used by /bad and OOM script)`);
print(`  elapsed         : ${elapsedSec}s`);
print("");
print("Next: ./start.sh  then  ./demo.sh oom");
