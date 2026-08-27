# Aggregation Anti-Patterns — Non-Obvious Only

Pipeline-stage mistakes that **look correct**, pass in dev, and fail silently or only at scale.

**One collection:** all examples use **`invoices`** only (embedded `lineItems` — no extra collections).

**Labelled demo documents:** load once, then query by `demoScenario` or `invoiceId`:

```bash
mongosh mongodb://localhost:27018/mongo_demo --file scripts/seed-demo-scenarios.mongosh.js
db.invoices.find({ demoScenario: { $exists: true } }, { invoiceId: 1, demoScenario: 1, _id: 0 })
```

Full catalog: [DEMO-SCENARIOS.md](DEMO-SCENARIOS.md)

**Validate with explain:**

```javascript
db.invoices.explain("executionStats").aggregate(pipeline)
```

Console walkthrough: [PIPELINE-PERFORMANCE-CONSOLE.md](PIPELINE-PERFORMANCE-CONSOLE.md)

---

## AP-1 — `$unwind` + `$group` by `$_id` to filter an array

**Scenario:** `demoScenario: "AP-1"` · `invoiceId: "DEMO-AP01"` (4 line items, 2 above $50)

**Trap:** SQL unnest → filter → regroup mental model. Introduces a **blocking `$group`** for work that is **per document**.

```javascript
// WRONG — fan-out + blocking regroup for one invoice's lineItems
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP01" } },
  { $unwind: "$lineItems" },
  { $match: { "lineItems.unitPrice": { $gt: NumberDecimal("50") } } },
  { $group: {
      _id: "$_id",
      invoiceId: { $first: "$invoiceId" },
      lineItems: { $push: "$lineItems" }
  }}
])

// RIGHT — streaming array operator
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP01" } },
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

**Recognise:** `$group: { _id: "$_id" }` right after `$unwind` on an embedded array.

**OK when:** grouping by **SKU / region across documents** — that is global analytics, not per-doc array shaping.

---

## AP-2 — `$unwind` + `$group` to sum embedded array (no `$lookup` needed)

**Scenario:** `DEMO-AP01` — `lineItems` already embedded on `invoices` (no second collection).

**Trap:** Unwind embedded array and regroup with `$first` passthroughs instead of array math.

```javascript
// WRONG — unnecessary unwind + group on same document
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP01" } },
  { $unwind: "$lineItems" },
  { $group: {
      _id: "$_id",
      invoiceId: { $first: "$invoiceId" },
      lineTotal: { $sum: { $multiply: ["$lineItems.quantity", { $toDouble: "$lineItems.unitPrice" }] } },
      region: { $first: "$region" }
  }}
])

// RIGHT — $map + $sum on embedded array
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

On this demo, **never create a `line_items` collection** — everything lives on `invoices.lineItems`.

---

## AP-3 — `$match` on computed field when source equivalent exists

**Scenario:** `demoScenario: "AP-3"` · `invoiceId: "DEMO-AP03"` · `amount: 750.00`

```javascript
// WRONG — amountDisplay blocks filter pushdown
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP03" } },
  { $set: { amountDisplay: { $toDouble: "$amount" } } },
  { $match: { amountDisplay: { $gte: 500 } } }
])

// RIGHT — equivalent filter on source field
db.invoices.aggregate([
  { $match: {
      invoiceId: "DEMO-AP03",
      amount: { $gte: NumberDecimal("500.00") }
  }},
  { $set: { amountDisplay: { $toDouble: "$amount" } } }
])
```

**Explain:** GOOD pipeline → lower `totalDocsExamined`.

---

## AP-4 — No partial `$match` when computed filter is required

**Scenario:** `demoScenario: "AP-4"` · `DEMO-AP04` · `region: EU`, `reportingPeriod: 2024-08`

```javascript
// WRONG — only computed label filter
db.invoices.aggregate([
  { $match: { demoScenario: "AP-4" } },
  { $set: { reportingLabel: { $concat: ["$region", "-", "$reportingPeriod"] } } },
  { $match: { reportingLabel: { $regex: /^EU-2024-/ } } }
])

// RIGHT — partial $match on source fields first
db.invoices.aggregate([
  { $match: {
      demoScenario: "AP-4",
      reportingPeriod: { $gte: "2024-06" }
  }},
  { $set: { reportingLabel: { $concat: ["$region", "-", "$reportingPeriod"] } } },
  { $match: { reportingLabel: { $regex: /^EU-2024-/ } } }
])
```

First `$match` may admit a few extra docs; second removes them — **same final output**, less work.

---

## AP-5 — `$group` then `$match` — filters groups, not documents

**Scenario:** `demoScenario: "AP-5"` · `DEMO-AP05-READY` + `DEMO-AP05-PENDING` (same region, different status)

```javascript
// WRONG — status filter after group does not reduce docs entering $group
db.invoices.aggregate([
  { $group: {
      _id: "$region",
      total: { $sum: { $toDouble: "$amount" } },
      readyCount: {
        $sum: { $cond: [{ $eq: ["$status", "READY"] }, 1, 0] }
      }
  }},
  { $match: { total: { $gt: 100000 } } }   // OK — filters groups
])

// If you meant "only READY invoices in the rollup":
// WRONG placement
db.invoices.aggregate([
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } },
  { $match: { status: "READY" } }            // status is gone — wrong or no-op
])

// RIGHT
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } },
  { $match: { total: { $gt: 100000 } } }     // group filter — intentional
])
```

---

## AP-6 — Inclusion `$project` to add one field

**Scenario:** `demoScenario: "AP-6"` · `invoiceId: "DEMO-AP06"`

```javascript
// WRONG — 10+ field names just to add lineItemCount
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP06" } },
  { $project: {
      lineItemCount: { $size: "$lineItems" },
      invoiceId: 1, orgId: 1, region: 1, status: 1,
      reportingPeriod: 1, amount: 1, currency: 1,
      lineItems: 1, supplier: 1, metadata: 1,
      _id: 0
  }}
])

// RIGHT
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP06" } },
  { $set: { lineItemCount: { $size: "$lineItems" } } },
  { $unset: "_id" }
])
```

**Trap:** Must name every existing field; new schema fields are **silently dropped**.

See [SET-UNSET-VS-PROJECT.md](SET-UNSET-VS-PROJECT.md).

---

## AP-7 — `$unset` every field to build a small API shape

**Scenario:** `DEMO-AP06` (same doc as AP-6)

```javascript
// WRONG — must name every field to drop
db.invoices.aggregate([
  { $match: { invoiceId: "DEMO-AP06" } },
  { $set: {
      billing: {
        period: "$reportingPeriod",
        amount: "$amount",
        currency: "$currency"
      }
  }},
  { $unset: [
      "_id", "invoiceId", "orgId", "region", "status", "reportingPeriod",
      "supplier", "lineItems", "taxBreakdown", "amount", "currency",
      "metadata", "createdAt", "updatedAt"
  ]}
])

// RIGHT — whitelist small output
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $limit: 1 },
  { $project: {
      _id: 0,
      billing: {
        period: "$reportingPeriod",
        amount: "$amount",
        currency: "$currency"
      }
  }}
])
```

---

## AP-8 — Early inclusion `$project` before `$group` (kills covered query)

**Scenario:** `demoScenario: "AP-8"` · `DEMO-AP08` (heavy `metadata` blob)

```javascript
// WRONG — pulls full docs including lineItems into group hash
db.invoices.aggregate([
  { $match: { demoScenario: "AP-8" } },
  { $project: {
      region: 1, amount: 1, lineItems: 1, metadata: 1, _id: 1
  }},
  { $group: {
      _id: "$region",
      total: { $sum: { $toDouble: "$amount" } }
  }}
])

// RIGHT — drop heavy fields, keep only what $group needs
db.invoices.aggregate([
  { $match: { demoScenario: "AP-8" } },
  { $unset: [ "lineItems", "metadata", "supplier" ] },
  { $group: {
      _id: "$region",
      total: { $sum: { $toDouble: "$amount" } }
  }}
])
```

**Trap:** Explicitly requesting `_id` + fat fields forces engine to load full documents even when `$group` only needs two fields.

---

## AP-9 — `$addToSet: "$$ROOT"` / unbounded `$push` for “latest per group”

**Scenario:** `demoScenario: "AP-9"` · `DEMO-AP09-OLD`, `DEMO-AP09-MID`, `DEMO-AP09-NEW` (same `reportingPeriod: 2024-07`)

```javascript
// WRONG — all invoice versions per reportingPeriod in one array
db.invoices.aggregate([
  { $match: { demoScenario: "AP-9" } },
  { $group: {
      _id: "$reportingPeriod",
      versions: { $addToSet: "$$ROOT" }
  }}
])

// RIGHT — latest per period
db.invoices.aggregate([
  { $match: { demoScenario: "AP-9" } },
  { $sort: { reportingPeriod: 1, updatedAt: -1 } },
  { $group: {
      _id: "$reportingPeriod",
      latest: { $first: "$$ROOT" }
  }}
])
```

**Trap:** Arrays grow with history; hits **16 MB** group document limit.

---

## AP-10 — `$skip` / `$limit` without stable `$sort`

**Scenario:** bulk `invoices` — `{ orgId: "org-alpha", status: "READY" }` (100k seed)

```javascript
// WRONG — unstable pages under concurrent writes
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $skip: 100 },
  { $limit: 50 }
])

// RIGHT
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $sort: { createdAt: -1, _id: 1 } },
  { $skip: 100 },
  { $limit: 50 }
])
```

---

## AP-11 — Deep `$skip` export loop (quadratic cost)

**Trap:** Page 50 re-walks 500k skipped documents every time.

```javascript
// WRONG — O(n²) export
for (let page = 0; page < 50; page++) {
  db.invoices.aggregate([
    { $match: { orgId: "org-alpha", status: "READY" } },
    { $sort: { _id: 1 } },
    { $skip: page * 10000 },
    { $limit: 10000 }
  ])
}

// RIGHT — seek pagination
let lastId = null
while (true) {
  const batch = db.invoices.aggregate([
    { $match: {
        orgId: "org-alpha",
        status: "READY",
        ...(lastId ? { _id: { $gt: lastId } } : {})
    }},
    { $sort: { _id: 1 } },
    { $limit: 10000 }
  ]).toArray()
  if (batch.length === 0) break
  lastId = batch[batch.length - 1]._id
}
```

---

## AP-12 — `$sort` + `$limit` not adjacent (misses top-K optimisation)

**Trap:** Extra stage between `$sort` and `$limit` prevents engine from coalescing to O(limit) heap sort.

```javascript
// WRONG — full sort of all groups, then project, then limit
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } },
  { $sort: { total: -1 } },
  { $project: { region: "$_id", total: 1, _id: 0 } },
  { $limit: 5 }
])

// RIGHT — $sort and $limit back-to-back
db.invoices.aggregate([
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
  { $project: { region: "$_id", total: 1, _id: 0 } }
])
```

---

## AP-13 — `$sum` with `$toDouble` without `$convert` on dirty ERP data

**Scenario:** `demoScenario: "AP-13"` · `DEMO-AP13` · `metadata.amountRaw: "N/A"`

```javascript
// WRONG — any non-numeric amount kills the pipeline
db.invoices.aggregate([
  { $match: { orgId: "org-alpha" } },
  { $group: {
      _id: "$region",
      total: { $sum: { $toDouble: "$amount" } }
  }}
])

// RIGHT — defensive coercion inside $group
db.invoices.aggregate([
  { $match: { orgId: "org-alpha" } },
  { $group: {
      _id: "$region",
      total: { $sum: {
          $convert: {
            input: "$amount",
            to: "double",
            onError: 0,
            onNull: 0
          }
      }}
  }}
])
```

---

## Quick reference

| ID | Smell in pipeline | Fix |
|----|-------------------|-----|
| AP-1 | `$unwind` → `$group` by `$_id` | `$filter` / `$map` on array |
| AP-2 | `$lookup` → `$unwind` → `$group` for totals | `$sum` / `$size` on `as` array |
| AP-3 | `$match` on `$set` output | `$match` on source field first |
| AP-4 | One `$match` only on computed field | Partial `$match` on indexed fields at top |
| AP-5 | Document filter after `$group` | `$match` documents before `$group` |
| AP-6 | `$project` lists all fields to add one | `$set` + `$unset` |
| AP-7 | `$unset` lists all fields to keep three | `$project` whitelist |
| AP-8 | Fat `$project` before `$group` | `$unset` heavy fields |
| AP-9 | `$addToSet: "$$ROOT"` | `$sort` + `$first` / `$top` |
| AP-10 | `$skip` without `$sort` | Stable `$sort` + `_id` tiebreaker |
| AP-11 | `skip = page × size` loop | Seek on `_id` |
| AP-12 | Stage between `$sort` and `$limit` | Adjacent `$sort` → `$limit` |
| AP-13 | `$toDouble` in `$sum` on dirty data | `$convert` with `onError` |

---

## Review checklist (aggregation only)

- [ ] No `$group: { _id: "$_id" }` after `$unwind` on embedded array
- [ ] Join totals use array expressions, not unwind+group
- [ ] `$match` on source fields where equivalent exists; partial top `$match` if computed filter needed
- [ ] Document `$match` before `$group`; post-group `$match` only for group predicates
- [ ] `$set`/`$unset` for small shape changes; `$project` for small whitelist output
- [ ] `$unset` wide fields before blocking `$group`
- [ ] No `$addToSet: "$$ROOT"` / unbounded `$push` in `$group`
- [ ] `$sort` before `$skip`; seek pagination for large exports
- [ ] `$sort` immediately before `$limit` for top-K
- [ ] `$convert` with `onError` on untrusted numeric fields in accumulators
- [ ] `explain("executionStats")` on changed pipelines

---

| ID | Scenario filter | `invoiceId` |
|----|-----------------|-------------|
| AP-1 | `{ demoScenario: "AP-1" }` | `DEMO-AP01` |
| AP-2 | same | `DEMO-AP01` |
| AP-3 | `{ demoScenario: "AP-3" }` | `DEMO-AP03` |
| AP-4 | `{ demoScenario: "AP-4" }` | `DEMO-AP04` |
| AP-5 | `{ demoScenario: "AP-5" }` | `DEMO-AP05-*` |
| AP-6/7 | `{ demoScenario: "AP-6" }` | `DEMO-AP06` |
| AP-8 | `{ demoScenario: "AP-8" }` | `DEMO-AP08` |
| AP-9 | `{ demoScenario: "AP-9" }` | `DEMO-AP09-*` |
| AP-10–12 | `{ orgId: "org-alpha", status: "READY" }` | bulk `INV-*` |
| AP-13 | `{ demoScenario: "AP-13" }` | `DEMO-AP13` |

---

## Demos in this repo

| Topic | File |
|-------|------|
| Load labelled docs | `scripts/seed-demo-scenarios.mongosh.js` |
| Scenario catalog | [DEMO-SCENARIOS.md](DEMO-SCENARIOS.md) |
| AP-1–3, 10–12 | [PIPELINE-PERFORMANCE-CONSOLE.md](PIPELINE-PERFORMANCE-CONSOLE.md) |
| AP-6, AP-7 | [SET-UNSET-VS-PROJECT.md](SET-UNSET-VS-PROJECT.md) |
