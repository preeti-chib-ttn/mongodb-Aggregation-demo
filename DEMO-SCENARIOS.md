# Demo Scenarios — One Collection, All Examples

All aggregation demos use **`invoices` only**. No `line_items`, `orders`, or extra collections.

Labelled documents have:
- **`demoScenario`** — e.g. `"AP-1"`, `"AP-9"` (maps to anti-pattern)
- **`invoiceId`** — e.g. `DEMO-AP01` (use in `$match`)
- **`demoNote`** — what the document is for

Bulk seed (`INV-00000000` … `INV-00099999`) stays for OOM / scale demos. Scenario docs sit alongside it.

---

## Load scenarios

```bash
./start.sh
mongosh mongodb://localhost:27018/mongo_demo --file scripts/seed-demo-scenarios.mongosh.js
```

Docker:

```bash
docker compose exec mongo mongosh mongo_demo --file /scripts/seed-demo-scenarios.mongosh.js
```

Re-run anytime — **upserts** by `invoiceId`, does not delete bulk data.

---

## List & identify scenarios

```javascript
use mongo_demo

// All labelled demo documents
db.invoices.find(
  { demoScenario: { $exists: true } },
  { invoiceId: 1, demoScenario: 1, demoNote: 1, status: 1, region: 1, amount: 1, _id: 0 }
).sort({ demoScenario: 1, invoiceId: 1 })
```

```javascript
// One scenario
db.invoices.find({ demoScenario: "AP-1" })
```

```javascript
// Count by scenario
db.invoices.aggregate([
  { $match: { demoScenario: { $exists: true } } },
  { $group: { _id: "$demoScenario", ids: { $push: "$invoiceId" }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } }
])
```

---

## Scenario catalog

| Scenario | `invoiceId` | Anti-patterns | What’s special |
|----------|-------------|---------------|----------------|
| **AP-1** | `DEMO-AP01` | AP-1, AP-2 | 4 `lineItems`: 2 priced > $50, 2 ≤ $50 |
| **AP-3** | `DEMO-AP03` | AP-3 | `amount` = 750.00 — match source vs `$set` display field |
| **AP-4** | `DEMO-AP04` | AP-4 | `region=EU`, `reportingPeriod=2024-08` — partial `$match` |
| **AP-5** | `DEMO-AP05-READY`, `DEMO-AP05-PENDING` | AP-5 | Same region; different `status` — filter docs before `$group` |
| **AP-6** | `DEMO-AP06` | AP-6, AP-7 | Fat doc — `$set`/`$unset` vs `$project` |
| **AP-8** | `DEMO-AP08` | AP-8 | Heavy `metadata` — `$unset` before `$group` |
| **AP-9** | `DEMO-AP09-OLD/MID/NEW` | AP-9 | Same `reportingPeriod=2024-07`, different `updatedAt` |
| **AP-13** | `DEMO-AP13` | AP-13 | `metadata.amountRaw: "N/A"` — `$convert` in `$group` |

### Uses bulk `invoices` only (no DEMO doc needed)

| Anti-pattern | Filter | Why bulk data is enough |
|--------------|--------|-------------------------|
| AP-10 | `{ orgId: "org-alpha", status: "READY" }` | Pagination needs many rows |
| AP-11 | same | Deep `$skip` / seek export |
| AP-12 | same | Top-K `$sort` + `$limit` on region rollup |

---

## Quick commands per scenario

### AP-1 — `$filter` vs `$unwind` + `$group`

```javascript
const id = "DEMO-AP01";
const threshold = NumberDecimal("50.00");

// WRONG
db.invoices.aggregate([
  { $match: { invoiceId: id } },
  { $unwind: "$lineItems" },
  { $match: { "lineItems.unitPrice": { $gt: threshold } } },
  { $group: { _id: "$_id", invoiceId: { $first: "$invoiceId" }, lineItems: { $push: "$lineItems" } } }
])

// RIGHT
db.invoices.aggregate([
  { $match: { invoiceId: id } },
  { $set: { lineItems: { $filter: {
      input: "$lineItems", as: "line",
      cond: { $gt: ["$$line.unitPrice", threshold] }
  }}}},
  { $project: { _id: 0, invoiceId: 1, lineItems: 1 } }
])
```

### AP-2 — line total on embedded array (no `$lookup`)

```javascript
// RIGHT — no second collection
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP01" } },
  { $set: {
      lineTotal: { $sum: {
        $map: {
          input: "$lineItems", as: "line",
          in: { $multiply: ["$$line.quantity", { $toDouble: "$$line.unitPrice" }] }
        }
      }}
  }},
  { $project: { _id: 0, invoiceId: 1, lineTotal: 1 } }
])
```

### AP-3 — `$match` on source `amount`

```javascript
// WRONG
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP03" } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } }
])

// RIGHT
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP03", amount: { $gte: NumberDecimal("500.00") } } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } }
])
```

### AP-4 — partial `$match`

```javascript
db.invoices.aggregate([
  { $match: { demoScenario: "AP-4", reportingPeriod: { $gte: "2024-06" } } },
  { $set: { reportingLabel: { $concat: ["$region", "-", "$reportingPeriod"] } } },
  { $match: { reportingLabel: { $regex: /^EU-2024-/ } } },
  { $project: { _id: 0, invoiceId: 1, reportingLabel: 1 } }
])
```

### AP-5 — `$match` before `$group`

```javascript
// WRONG — PENDING included in rollup
db.invoices.aggregate([
  { $match: { demoScenario: "AP-5" } },
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } }
])

// RIGHT
db.invoices.aggregate([
  { $match: { demoScenario: "AP-5", status: "READY" } },
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } }
])
```

### AP-9 — latest per period (`$first`, not `$addToSet`)

```javascript
// WRONG
db.invoices.aggregate([
  { $match: { demoScenario: "AP-9" } },
  { $group: { _id: "$reportingPeriod", versions: { $addToSet: "$$ROOT" } } }
])

// RIGHT
db.invoices.aggregate([
  { $match: { demoScenario: "AP-9" } },
  { $sort: { reportingPeriod: 1, updatedAt: -1 } },
  { $group: { _id: "$reportingPeriod", latestId: { $first: "$invoiceId" }, latestAmount: { $first: "$amount" } } }
])
```

### AP-13 — `$convert` on dirty field

```javascript
db.invoices.aggregate([
  { $match: { demoScenario: "AP-13" } },
  { $group: {
      _id: "$region",
      safeTotal: { $sum: { $convert: { input: "$amount", to: "double", onError: 0, onNull: 0 } } },
      dirtyTotal: { $sum: { $convert: { input: "$metadata.amountRaw", to: "double", onError: 0, onNull: 0 } } }
  }}
])
```

---

## Explain helper

```javascript
function compareExplain(label, pipeline) {
  const ex = db.invoices.explain("executionStats").aggregate(pipeline);
  const s = ex.executionStats || ex.stages?.at(-1)?.$cursor?.executionStats;
  print(label + " → examined: " + s?.totalDocsExamined + "  returned: " + s?.nReturned + "  ms: " + s?.executionTimeMillis);
}

compareExplain("AP-3 BAD", [
  { $match: { invoiceId: "DEMO-AP03" } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } }
]);
compareExplain("AP-3 GOOD", [
  { $match: { invoiceId: "DEMO-AP03", amount: { $gte: NumberDecimal("500.00") } } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } }
]);
```

---

## Files

| File | Purpose |
|------|---------|
| `scripts/seed-demo-scenarios.mongosh.js` | Upsert labelled docs into `invoices` |
| `AGGREGATION-ANTI-PATTERNS.md` | Full WRONG/RIGHT pipelines |
| `scripts/seed-invoices.mongosh.js` | Bulk 100k `INV-*` for scale/OOM |
