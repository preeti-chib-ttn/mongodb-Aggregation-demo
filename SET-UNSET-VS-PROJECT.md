# Better Alternatives to `$project` — `$set` & `$unset`

When you need to shape documents in an aggregation pipeline, **`$project` is not the default choice**. For most pipelines that keep most of the original fields and change only a few, **`$set` and `$unset`** are clearer, shorter, and safer as your data model evolves.

This guide uses the **`invoices`** collection from this demo (`mongo_demo` database).

**Run the live examples:**

```bash
./start.sh
mongosh mongodb://localhost:27018/mongo_demo --file scripts/set-unset-vs-project.mongosh.js
```

---

## Why `$project` is awkward

| Problem | What it means |
|---------|----------------|
| **Include OR exclude, not both** | In one `$project` you either list fields to keep (`field: 1`) or drop (`field: 0`). Exception: you may exclude `_id` while including other fields. |
| **Verbose for small changes** | To add one field you often must **name every other field** you want to keep. With 20+ fields per invoice, the stage grows fast. |
| **Brittle when schema evolves** | New fields appear in documents (e.g. `settlementDate`) — with inclusion `$project`, they are **silently dropped** until you update the pipeline. |
| **Covered-query risk** | Over-including fields in an early `$project` can force the engine to load more from disk than needed. Forgetting `"_id": 0` is a common mistake. |

> `$addFields` (3.4+) is an alias for **`$set`** (4.2+). This doc uses `$set` for clarity.

---

## When to use `$set` & `$unset` (most cases)

**Use when:** you keep **most** of the document and only add, modify, or remove a **few** fields.

### Our invoice — input shape (sample)

```javascript
{
  _id: ObjectId("..."),
  invoiceId: "INV-00000042",
  orgId: "org-alpha",
  region: "EU",
  status: "READY",
  reportingPeriod: "2024-03",
  supplier: { supplierId: "SUP-42", name: "Supplier 42 Ltd", ... },
  lineItems: [ /* 4–10 line objects */ ],
  taxBreakdown: [ ... ],
  amount: NumberDecimal("100.12"),
  currency: "EUR",
  metadata: { sourceSystem: "ERP-SAP", reconciliationNotes: "...", ... },
  createdAt: ISODate("2024-03-15T08:00:00Z"),
  updatedAt: ISODate("...")
}
```

### Goal — export prep (keep almost everything)

Requirements:

1. Add **`lineItemCount`** from `lineItems` array size  
2. Add **`exportBatch`** literal `"INVOICE-EXPORT"`  
3. Remove verbose internal **`metadata`**  
4. Remove **`_id`** from API response  

#### BAD — `$project` (must name every retained field)

```javascript
[
  { $match: { invoiceId: "INV-00000042" } },
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
      _id: 0
  }}
]
```

If finance later adds `settlementDate` to invoices, this pipeline **drops it** until someone adds `"settlementDate": 1`.

#### GOOD — `$set` + `$unset`

```javascript
[
  { $match: { invoiceId: "INV-00000042" } },
  { $set: {
      lineItemCount: { $size: "$lineItems" },
      exportBatch: "INVOICE-EXPORT"
  }},
  { $unset: [ "metadata", "_id" ] }
]
```

New fields on the source document **pass through automatically**. Only the fields you touch are named.

### Spring Boot equivalent

```java
Aggregation pipeline = Aggregation.newAggregation(
    Aggregation.match(Criteria.where("invoiceId").is("INV-00000042")),
    Aggregation.addFields()
        .addField("lineItemCount").withValueOf(ArrayOperators.Size.lengthOfArray("$lineItems"))
        .addField("exportBatch").withValue("INVOICE-EXPORT")
        .build(),
    Aggregation.unset("metadata", "_id")
);
```

Or with raw `Document` stages via `Aggregation.stage(...)` if expressions are simpler in BSON.

---

## When to use `$project` (narrow output)

**Use when:** the output shape is **very different** from the input and you only need a **small subset** of fields.

### Goal — dashboard summary (tiny output)

Requirements:

1. Nested **`billing`**: `{ period, amount, currency }`  
2. **`statusLabel`**: `"READY"` → `"Ready for export"`, else `"In progress"`  
3. Drop everything else (supplier, lineItems, metadata, …)  

#### BAD — `$set` + `$unset` (must name every field to remove)

```javascript
[
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $limit: 1 },
  { $set: {
      "billing.period": "$reportingPeriod",
      "billing.amount": "$amount",
      "billing.currency": "$currency",
      statusLabel: {
        $cond: {
          if: { $eq: ["$status", "READY"] },
          then: "Ready for export",
          else: "In progress"
        }
      }
  }},
  { $unset: [
      "_id", "invoiceId", "orgId", "region", "status", "reportingPeriod",
      "supplier", "lineItems", "taxBreakdown", "amount", "currency",
      "metadata", "createdAt", "updatedAt"
  ]}
]
```

Every new field added to invoices in the future must be **added to `$unset`** or it leaks into the API.

#### GOOD — `$project` (declare only what you want)

```javascript
[
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $limit: 1 },
  { $project: {
      _id: 0,
      billing: {
        period: "$reportingPeriod",
        amount: "$amount",
        currency: "$currency"
      },
      statusLabel: {
        $cond: {
          if: { $eq: ["$status", "READY"] },
          then: "Ready for export",
          else: "In progress"
        }
      }
  }}
]
```

Unknown future fields are **excluded by default**. The pipeline stays short.

### Spring Boot equivalent

```java
Aggregation.project()
    .and("reportingPeriod").as("billing.period")
    .and("amount").as("billing.amount")
    .and("currency").as("billing.currency")
    .and(ConditionalOperators.when(Criteria.where("status").is("READY"))
        .then("Ready for export")
        .otherwise("In progress"))
    .as("statusLabel")
    .andExclude("_id");
```

---

## Decision guide

```
                    ┌─────────────────────────────────────┐
                    │  Need to change field shape?        │
                    └─────────────────┬───────────────────┘
                                      │
              ┌───────────────────────┴───────────────────────┐
              │                                               │
     Keep MOST fields                               Keep FEW fields
     change a MINORITY                               new shape
              │                                               │
              ▼                                               ▼
        $set + $unset                                    $project
   (add / modify / remove)                    (whitelist final output)
```

| Situation | Prefer |
|-----------|--------|
| Add computed field, keep rest | `$set` |
| Remove PII or internal fields, keep rest | `$unset` |
| Rename / reshape one or two fields | `$set` |
| API DTO with 3–5 fields from a 30-field document | `$project` |
| Report row with nested summary object | `$project` |
| Evolving schema — new fields should flow through | `$set` / `$unset`, not inclusion `$project` |

---

## Placement in the pipeline

| Tip | Why |
|-----|-----|
| **`$match` first** | Filter before shaping — less work downstream |
| **`$unset` wide fields before `$group`** | Drops `metadata`, `lineItems` before blocking stages save RAM |
| **`$project` late** when used | Final shape is obvious; earlier `$group` may already drop unneeded fields |
| **Avoid early inclusion `$project`** | Don't pull fields you won't use — hurts index coverage |

Example — drop heavy fields before grouping:

```javascript
[
  { $match: { orgId: "org-alpha", status: "READY" } },
  { $unset: [ "lineItems", "metadata", "supplier" ] },  // shrink before $group
  { $group: { _id: "$region", total: { $sum: { $toDouble: "$amount" } } } }
]
```

---

## Main takeaway

| Default | Exception |
|---------|-----------|
| **`$set` + `$unset`** for field inclusion/exclusion when you keep most of the document | **`$project`** when output is a small, fixed whitelist very different from input |

---

## Files in this repo

| File | Purpose |
|------|---------|
| `scripts/set-unset-vs-project.mongosh.js` | Runnable BAD vs GOOD examples on `invoices` |
| `scripts/seed-invoices.mongosh.js` | Source data |
| `MONGODB-AGGREGATION-OPERATIONS-GUIDE.md` | Broader aggregation reference |
