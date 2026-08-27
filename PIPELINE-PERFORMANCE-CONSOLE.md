# Pipeline Performance — Console Commands

Copy-paste into **mongosh** after `./start.sh`. Each section runs a **BAD** pipeline, then a **GOOD** one, then **explain** so you can see the difference.

```bash
mongosh mongodb://localhost:27018/mongo_demo
```

Or one-liner per section:

```bash
mongosh mongodb://localhost:27018/mongo_demo --eval '...'
```

---

## Setup (run once per session)

```javascript
use mongo_demo

// Sanity check — should print a number > 1000
db.invoices.countDocuments({ orgId: "org-alpha", status: "READY" })
```

---

## TIP 1 — Sort after match, not before

**Lesson:** `$sort` is blocking. Filter first so less data hits the sort.

### Run the queries

```javascript
// BAD — sort the whole collection, then filter
db.invoices.aggregate([
  { $sort: { amount: -1 } },
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $limit: 5 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, region: 1 } }
])

// GOOD — filter first, then top-5 by amount
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $sort: { amount: -1 } },
  { $limit: 5 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, region: 1 } }
])
```

### Explain — compare

```javascript
// BAD explain
db.invoices.explain("executionStats").aggregate([
  { $sort: { amount: -1 } },
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $limit: 5 }
])
```

```javascript
// GOOD explain
db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $sort: { amount: -1 } },
  { $limit: 5 }
])
```

### What to look for

```javascript
// Paste after each explain — quick readout
function readExplain(ex) {
  const stats = ex.executionStats || ex.stages?.at(-1)?.$cursor?.executionStats;
  print("totalDocsExamined : " + (stats?.totalDocsExamined ?? "n/a"));
  print("nReturned         : " + (stats?.nReturned ?? "n/a"));
  print("executionTimeMillis: " + (stats?.executionTimeMillis ?? "n/a"));
  const plan = ex.stages?.[0]?.$cursor?.queryPlanner?.winningPlan
    || ex.queryPlanner?.winningPlan;
  print("firstStage        : " + (plan?.stage ?? plan?.inputStage?.stage ?? "n/a"));
}
```

After BAD explain: `readExplain(ex)` — often **high** `totalDocsExamined` (scanned many docs).  
After GOOD explain: lower `totalDocsExamined`, `$match` appears early in stages.

---

## TIP 1b — Drop heavy fields before `$group`

**Lesson:** Don't carry `lineItems` into a blocking `$group`.

```javascript
// GOOD — unset wide fields, then group by region
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $unset: [ "lineItems", "metadata", "supplier" ] },
  { $group: {
      _id: "$region",
      count: { $sum: 1 },
      total: { $sum: { $toDouble: "$amount" } }
  }},
  { $sort: { total: -1 } }
])
```

```javascript
// Explain — check blocking stages
db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $unset: [ "lineItems", "metadata", "supplier" ] },
  { $group: { _id: "$region", count: { $sum: 1 }, total: { $sum: { $toDouble: "$amount" } } } },
  { $sort: { total: -1 } }
])
```

Look at `$group` / `$sort` stages for `usedDisk: true` (spilled to disk = suboptimal at scale).

---

## TIP 2 — `$filter` instead of `$unwind` + `$group`

**Lesson:** Filtering an array inside one invoice should not use a blocking `$group`.

### See the input

```javascript
db.invoices.findOne(
  { invoiceId: "INV-00000042" },
  { invoiceId: 1, "lineItems.unitPrice": 1, "lineItems.sku": 1 }
)
```

### Run the queries

```javascript
// BAD — unwind, filter, regroup (blocking $group)
db.invoices.aggregate([
  { $match: { invoiceId: "INV-00000042" } },
  { $unwind: "$lineItems" },
  { $match: { "lineItems.unitPrice": { $gt: NumberDecimal("50") } } },
  { $group: {
      _id: "$_id",
      invoiceId: { $first: "$invoiceId" },
      lineItems: { $push: "$lineItems" }
  }}
])

// GOOD — $filter (streaming, no $group)
db.invoices.aggregate([
  { $match: { invoiceId: "INV-00000042" } },
  { $set: {
      lineItems: {
        $filter: {
          input: "$lineItems",
          as: "line",
          cond: { $gt: ["$$line.unitPrice", NumberDecimal("50")] }
        }
      }
  }},
  { $project: { _id: 0, invoiceId: 1, lineItems: 1 } }
])
```

### Explain at scale (use org, not single invoice)

On one document explain looks the same — run on **all org-alpha** to see the cost of `$unwind` + `$group`:

```javascript
// BAD at scale
db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $unwind: "$lineItems" },
  { $match: { "lineItems.unitPrice": { $gt: NumberDecimal("50") } } },
  { $group: { _id: "$_id", lineItems: { $push: "$lineItems" } } }
])
```

```javascript
// GOOD at scale
db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $set: {
      lineItems: {
        $filter: {
          input: "$lineItems",
          as: "line",
          cond: { $gt: ["$$line.unitPrice", NumberDecimal("50")] }
        }
      }
  }}
])
```

### What to look for

| Signal | BAD (unwind+group) | GOOD ($filter) |
|--------|-------------------|----------------|
| Stages | `$unwind` → `$group` present | No `$group` |
| `totalDocsExamined` | Much higher (1 doc → many rows) | ~matches matched invoices |
| `executionTimeMillis` | Higher on 25k+ docs | Lower |

---

## TIP 3 — `$match` on source field, not computed field

**Lesson:** Match on `amount` before `$set`, so the filter can run early.

```javascript
// BAD — compute first, match second
db.invoices.aggregate([
  { $match: { orgId: "org-alpha" } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, amountDisplay: 1 } }
])

// GOOD — match on amount first
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", amount: { $gte: NumberDecimal("500.00") } } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, amount: 1, amountDisplay: 1 } }
])
```

### Explain

```javascript
let bad = db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha" } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } },
  { $limit: 3 }
])
readExplain(bad)
```

```javascript
let good = db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", amount: { $gte: NumberDecimal("500.00") } } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $limit: 3 }
])
readExplain(good)
```

**GOOD** should show lower `totalDocsExamined` — filter applied before transforming every doc.

### Partial match (bonus)

```javascript
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY", reportingPeriod: { $gte: "2024-06" } } },
  { $set: { reportingLabel: { $concat: ["$region", "-", "$reportingPeriod"] } } },
  { $match: { reportingLabel: { $regex: /^EU-2024-/ } } },
  { $limit: 3 },
  { $project: { _id: 0, invoiceId: 1, reportingLabel: 1, amount: 1 } }
])
```

First `$match` shrinks data; second refines on computed field.

---

## One-shot compare script (paste whole block)

Runs BAD vs GOOD for TIP 1 and TIP 3 with explain summary:

```javascript
use mongo_demo

function readExplain(ex) {
  const stats = ex.executionStats || ex.stages?.at(-1)?.$cursor?.executionStats;
  return {
    examined: stats?.totalDocsExamined,
    returned: stats?.nReturned,
    ms: stats?.executionTimeMillis
  };
}

function compare(label, badPipe, goodPipe) {
  print("\n══ " + label + " ══");
  const bad = readExplain(db.invoices.explain("executionStats").aggregate(badPipe));
  const good = readExplain(db.invoices.explain("executionStats").aggregate(goodPipe));
  print("BAD  → examined: " + bad.examined + "  returned: " + bad.returned + "  ms: " + bad.ms);
  print("GOOD → examined: " + good.examined + "  returned: " + good.returned + "  ms: " + good.ms);
  print(good.examined < bad.examined ? "✓ GOOD examined fewer docs" : "≈ similar (check stages manually)");
}

compare("TIP 1 sort order",
  [
    { $sort: { amount: -1 } },
    { $match: { orgId: "org-alpha", status: "READY" } },
    { $limit: 5 }
  ],
  [
    { $match: { orgId: "org-alpha", status: "READY" } },
    { $sort: { amount: -1 } },
    { $limit: 5 }
  ]
);

compare("TIP 3 match early",
  [
    { $match: { orgId: "org-alpha" } },
    { $set: { amountDisplay: { $toDouble: "$amount" } } },
    { $match: { amountDisplay: { $gte: 500 } } },
    { $limit: 3 }
  ],
  [
    { $match: { orgId: "org-alpha", amount: { $gte: NumberDecimal("500.00") } } },
    { $set: { amountDisplay: { $toDouble: "$amount" } } },
    { $limit: 3 }
  ]
);

compare("TIP 2 array filter (org scale)",
  [
    { $match: { orgId: "org-alpha", status: "READY" } },
    { $unwind: "$lineItems" },
    { $match: { "lineItems.unitPrice": { $gt: NumberDecimal("50") } } },
    { $group: { _id: "$_id", lineItems: { $push: "$lineItems" } } }
  ],
  [
    { $match: { orgId: "org-alpha", status: "READY" } },
    { $set: {
        lineItems: {
          $filter: {
            input: "$lineItems", as: "line",
            cond: { $gt: ["$$line.unitPrice", NumberDecimal("50")] }
          }
        }
    }}
  ]
);
```

---

## Explain cheat sheet

| Field | Good sign | Bad sign |
|-------|-----------|----------|
| `executionStats.totalDocsExamined` | Close to `nReturned` | Millions examined, few returned |
| `executionStats.executionTimeMillis` | Lower on GOOD pipeline | BAD much higher at scale |
| `stages[0].$cursor` | `$match` pushed into query plan | Full collection scan first |
| `$sort` / `$group` stage | `usedDisk: false` | `usedDisk: true` |
| `queryPlanner.winningPlan.stage` | `IXSCAN` | `COLLSCAN` on large collection |

### Pretty-print one explain stage

```javascript
let ex = db.invoices.explain("executionStats").aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $sort: { amount: -1 } },
  { $limit: 5 }
])
printjson(ex.stages)
```

---

## Related

| File | Purpose |
|------|---------|
| `PIPELINE-PERFORMANCE-GUIDE.md` | Full narrative + Spring examples |
| `scripts/pipeline-performance.mongosh.js` | Automated demo script |
