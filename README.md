# MongoDB JVM OOM Demo

Shows a common production bug: **MongoDB returns data fine, but the Java app loads everything into memory and crashes.**

| Endpoint | What it does | Result with 100k docs |
|----------|--------------|------------------------|
| `/bad` | `getMappedResults()` — loads **all** documents into a Java `List` | JVM runs out of memory |
| `/good` | Streams one document at a time | Works |
| `/options/broken` | Calls `withOptions()` but discards the return value | Options never reach MongoDB |
| `/options/fixed` | Chains `.withOptions(allowDiskUse, maxTime, comment)` | Options on the wire |

Data lives in a **Docker volume** — you seed once, then every session starts in seconds.

---

## Before your session (run once, ~3–5 min)

```bash
cd mongo-jvm-demo
chmod +x setup.sh start.sh demo.sh
./setup.sh
```

This will:
1. Start MongoDB in Docker (port **27018** — won't clash with local Mongo on 27017)
2. Load **100,000** invoices into a persistent volume
3. Build and start the Spring Boot app (port **8080**)

You only wait for this **once**. The data stays in the volume.

---

## During your session (instant)

```bash
./start.sh          # start MongoDB + app (~10 seconds)
./demo.sh oom       # show the bug — JVM OOM
./demo.sh good      # show the fix — streaming works
./demo.sh options   # withOptions() immutability trap
```

That's it.

---

## Other commands

```bash
./demo.sh stop      # stop containers (data kept in volume)
./demo.sh reset     # delete volume and run setup again
```

Optional — fewer documents for a quicker OOM:

```bash
LIMIT=50000 ./demo.sh oom
```

---

## How it works (30 seconds)

```
┌─────────────┐     aggregation      ┌─────────────┐
│   MongoDB   │ ──────────────────►  │  Java app   │
│  (server)   │   streams documents  │  (client)   │
└─────────────┘                      └─────────────┘
                                            │
                    /bad  →  List<Document>  →  ALL in heap  →  OOM
                    /good →  cursor loop    →  one at a time → OK
```

MongoDB does the heavy work efficiently. The crash happens because `/bad` calls `getMappedResults()` and holds every document on the JVM heap.

---

## Files

| File | Purpose |
|------|---------|
| `setup.sh` | One-time: Docker volume + seed + build |
| `start.sh` | Session start (fast) |
| `demo.sh` | `oom` / `good` / `stop` / `reset` |
| `docker-compose.yml` | MongoDB volume + app |
| `docker-compose.oom.yml` | Tiny heap (64 MB) for OOM demo |
| `scripts/seed-invoices.mongosh.js` | Loads invoice test data |
| `JVM-OOM-TECHNICAL-REFERENCE.md` | Heap sizes, limits, and OOM thresholds |
| `AGGREGATION-OPTIONS-TECHNICAL-REFERENCE.md` | `withOptions()`, allowDiskUse, maxTime, comment |
| `MONGODB-AGGREGATION-OPERATIONS-GUIDE.md` | Pipeline flow, stages, streaming/blocking, mongosh + Spring |
| `SET-UNSET-VS-PROJECT.md` | When to use `$set`/`$unset` vs `$project` |
| `PIPELINE-PERFORMANCE-GUIDE.md` | Stage ordering, `$filter` vs `$unwind`, early `$match` |
| `PIPELINE-PERFORMANCE-CONSOLE.md` | **Copy-paste mongosh commands + explain compare** |
| `AGGREGATION-ANTI-PATTERNS.md` | **Master anti-pattern list + code review checklist** |
| `DEMO-SCENARIOS.md` | **One collection — labelled docs per anti-pattern** |
| `scripts/seed-demo-scenarios.mongosh.js` | Upsert `DEMO-AP*` docs into `invoices` |
| `docs/aggregation-pipeline-flow.png` | Aggregation pipeline architecture diagram |
| `scripts/set-unset-vs-project.mongosh.js` | Runnable `$set`/`$unset` vs `$project` demo |
| `scripts/pipeline-performance.mongosh.js` | Runnable performance BAD vs GOOD demo |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No data yet. Run ./setup.sh first` | Run `./setup.sh` once |
| Port 8080 in use | `docker compose down` then `./start.sh` |
| App won't start after OOM demo | `./start.sh` restarts with normal heap |
| Want fresh data | `./demo.sh reset` |

**No Java or Maven needed on your laptop** — everything runs in Docker after `./setup.sh`.
