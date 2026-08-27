# Aggregation Options — The `withOptions()` Trap

## What execution options are

These are **not pipeline stages**. They ride alongside the stage array on the `aggregate` command:

| Option | Purpose | Console equivalent |
|--------|---------|-------------------|
| `allowDiskUse` | Permit blocking stages (`$sort`, `$group`, …) to spill past the 100 MB RAM limit | `{ allowDiskUse: true }` as 2nd arg to `aggregate()` |
| `maxTime` / `maxTimeMS` | Server-side time limit; aborts with timeout error | `{ maxTimeMS: 30000 }` |
| `comment` | Appears in `currentOp`, profiler, logs — ops traceability | `{ comment: "analytics/v1" }` |

From MongoDB 6.0+, `allowDiskUseByDefault` is often `true` server-side — the flag may be a no-op on modern clusters. **`maxTime` and `comment` are never no-ops.**

---

## The trap — immutable `Aggregation`

Spring Data's `Aggregation` is **immutable**. `withOptions()` returns a **new** instance:

```java
// WRONG — return value discarded; server receives default options
Aggregation pipeline = Aggregation.newAggregation(match, group, sort, lim);
pipeline.withOptions(options);
mongoTemplate.aggregate(pipeline, "invoices", Document.class);

// RIGHT — chain or assign
Aggregation pipeline = Aggregation.newAggregation(match, group, sort, lim)
    .withOptions(options);
mongoTemplate.aggregate(pipeline, "invoices", Document.class);
```

**Symptom:** Developer "set" `allowDiskUse`, `maxTime`, and `comment` in code. Profiler and `currentOp` show none of them. Query runs with defaults. Pure **client-side** mistake — MongoDB never knew.

---

## Second trap — `toPipeline()` drops options

`Aggregation.toPipeline()` extracts **stage documents only**. Execution options live on the Spring object, not in the BSON array.

```java
// WRONG — options on Spring Aggregation are ignored by raw driver path
collection.aggregate(pipeline.toPipeline(context)).iterator();

// RIGHT — set options on AggregateIterable
collection.aggregate(pipeline.toPipeline(context))
    .allowDiskUse(true)
    .maxTime(30, TimeUnit.SECONDS)
    .comment("analytics/v1")
    .iterator();
```

Demo endpoint: `GET /options/raw-driver-trap`

---

## Demo pipeline (same in console and Spring)

```
$match   { orgId, status: "READY" }
$group   by region → count
$sort    count DESC        ← blocking
$limit   N
```

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `orgId` | `org-alpha` | Partition — ~25k READY docs per org in seed |
| `limit` | `10` | Top regions returned |

---

## Demo commands

```bash
./start.sh

# Spring — broken vs fixed
curl -s "http://localhost:8080/options/broken"
curl -s "http://localhost:8080/options/fixed"

# maxTime discarded — query completes despite "1ms" intent
curl -s "http://localhost:8080/options/maxtime-trap"

# toPipeline() loses options
curl -s "http://localhost:8080/options/raw-driver-trap"

# Or via demo.sh (Spring endpoints only)
./demo.sh options

# Console script (optional — run manually when needed)
mongosh mongodb://localhost:27018/mongo_demo --file scripts/aggregation-options.mongosh.js
```

---

## What to look for in responses

### `/options/broken`

```
Intended options:  allowDiskUse=true  comment=demo/...  maxTime=30000ms
Options on wire:   allowDiskUse=false comment=null      maxTime=unset
Query completed   ← maxTime never applied; allowDiskUse never sent
```

### `/options/fixed`

```
Intended options:  allowDiskUse=true  comment=demo/...  maxTime=30000ms
Options on wire:   allowDiskUse=true  comment=demo/...  maxTime=30000ms
```

### Console `maxTimeMS: 1`

Server aborts immediately — proves the option works when actually sent:

```
Exceeded time limit
```

### `/options/maxtime-trap`

Spring discards 1 ms `maxTime` → query **completes**. Contrast with console step 4.

---

## Production checklist

- [ ] `withOptions()` result **chained or assigned**?
- [ ] Using raw driver? Options on `AggregateIterable`, not only Spring object?
- [ ] `comment` set for HTTP-facing analytics (grep `currentOp` at 2am)?
- [ ] `maxTime` set so pathological queries release the request thread?
- [ ] `allowDiskUse` only when explain shows `usedDisk: true` on blocking stages?

---

## Files

| File | Purpose |
|------|---------|
| `AggregationOptionsController.java` | `/options/*` endpoints |
| `InvoiceAnalyticsPipeline.java` | Shared pipeline + option builders |
| `scripts/aggregation-options.mongosh.js` | Console equivalents (manual — not run by demo.sh) |
| `demo.sh options` | Spring `/options/*` endpoints only |
