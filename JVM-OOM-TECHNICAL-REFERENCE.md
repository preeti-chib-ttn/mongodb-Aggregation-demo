# JVM Heap & OOM — Demo Reference

## Parameters

| Symbol | Meaning | Demo source |
|--------|---------|-------------|
| **N** | Documents materialized | `GET /bad?limit=N` |
| **S** | Heap bytes per document (Java object) | Measure for your document shape; estimate **8–12× BSON size** |
| **B** | JVM baseline heap (framework, threads, pools) | Measure once for your app; estimate **40–80 MB** for Spring Boot |
| **Xmx** | Maximum JVM heap (`-Xmx`) | `docker-compose.yml` / `docker-compose.oom.yml` |
| **batch** | Cursor batch size (streaming only) | `500` on `/good` |

Actual documents returned: `min(N, matching documents in collection)`.

---

## Expected memory — `/bad` (materialization)

```
Heap_required  ≈  B  +  (N × S)
```

**OOM occurs when:**

```
B + (N × S)  >  Xmx
```

Rearranged — maximum safe `limit` for a given heap:

```
N_safe  ≈  (Xmx − B) / S
```

### Worked example (plug in your numbers)

| Input | Value |
|-------|------:|
| N (`limit`) | 50,000 |
| S (heap per doc) | 10 KB |
| B (baseline) | 50 MB |
| Xmx | 256 MB |

```
Heap_required  =  50 MB  +  (50,000 × 10 KB)
               =  50 MB  +  500 MB
               =  550 MB

550 MB  >  256 MB  →  OutOfMemoryError expected on /bad
```

| Input | Value |
|-------|------:|
| N (`limit`) | 500 |
| S | 10 KB |
| B | 50 MB |
| Xmx | 64 MB |

```
Heap_required  =  50 MB  +  (500 × 10 KB)
               =  50 MB  +  5 MB
               =  55 MB

55 MB  <  64 MB  →  request completes (no OOM)
```

---

## Expected memory — `/good` (streaming)

```
Heap_required  ≈  B  +  (batch × S)
```

With `batch = 500` and `S = 10 KB`:

```
Heap_required  ≈  B  +  ~5 MB
```

**N does not appear in the formula** — result set size does not drive heap growth. OOM from result volume is not expected on `/good`.

---

## Why OOM happens (demo narrative)

```
MongoDB (server)                JVM (client)
─────────────────               ─────────────────────────────────────
$match + $limit                 getMappedResults()
streams documents      →        builds List<Document> for ALL N docs
efficiently                     entire list lives on heap until GC
```

1. MongoDB executes the pipeline and streams results over the wire.
2. `/bad` calls `getMappedResults()`, which decodes every BSON document into a Java `Document` and stores it in an `ArrayList`.
3. Heap grows linearly with **N** — not with server load or pipeline cost.
4. When `B + (N × S) > Xmx`, the JVM throws `OutOfMemoryError`. The HTTP connection drops; MongoDB was not the bottleneck.

**Anti-pattern:** `results.getMappedResults()`  
**Fix:** cursor / stream — process one document, discard, repeat (`/good`).

---

## Demo commands

```bash
./start.sh
LIMIT=<N> ./demo.sh oom     # /bad  — materializes N documents
LIMIT=<N> ./demo.sh good    # /good — streams N documents
```

Use the formula above with your chosen `N`, `Xmx`, and measured `S` / `B` to predict the outcome before running.

---

## Footnote — JVM heap flags

| Flag | Meaning |
|------|---------|
| **`-Xms`** | Initial heap size. JVM allocates this at startup. Demo: `128m` (normal), `32m` (OOM mode). |
| **`-Xmx`** | Maximum heap size. Hard cap — OOM when exceeded. Demo: `256m` (normal), `64m` (OOM mode). |
| **`-XX:+HeapDumpOnOutOfMemoryError`** | Writes a `.hprof` file on OOM for post-mortem analysis. |
| **`-XX:HeapDumpPath`** | Directory/file for the heap dump. |

**Notes for the demo:**
- **`-Xmx` is the number that matters for OOM prediction** — it is the ceiling in the formula.
- **`-Xms < -Xmx`** avoids resize churn at startup; it does not raise the OOM threshold.
- **B (baseline)** is everything on the heap before query results: Spring context, Tomcat, MongoDB driver connection pool, thread stacks. It is not controlled by `limit` — only by your application footprint.
- **S (per document)** depends on document shape and driver mapping (`Document` vs POJO). Measure with a heap profiler or approximate as **8–12× BSON size** for nested documents.
