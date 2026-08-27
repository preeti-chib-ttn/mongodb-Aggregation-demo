// Aggregation options — console reference (optional; not run by ./demo.sh options)
//
// Run manually:
//   mongosh mongodb://localhost:27018/mongo_demo scripts/aggregation-options.mongosh.js
//
// Environment:
//   ORG_ID=org-alpha   partition key (default org-alpha)
//   LIMIT=10           top-N regions (default 10)

const ORG_ID = process.env.ORG_ID || "org-alpha";
const LIMIT = parseInt(process.env.LIMIT || "10", 10);
const COMMENT = "demo/invoice-analytics-by-region/v1";

const topRegionsPipeline = [
  { $match: { orgId: ORG_ID, status: "READY" } },
  { $group: { _id: "$region", count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: LIMIT },
];

function section(title, body) {
  print("");
  print("═".repeat(62));
  print(" " + title);
  print("═".repeat(62));
  if (body) {
    print(body);
  }
}

section("STEP 1 — Baseline pipeline (no execution options)", `
  Same stages as Spring demo: $match → $group → $sort → $limit
  Console equivalent of mongoTemplate.aggregate(pipeline) with default options.
`);
printjson(db.invoices.aggregate(topRegionsPipeline).toArray());

section("STEP 2 — Options on the wire (console has no withOptions() trap)", `
  In mongosh, pass options as the 2nd argument to aggregate().
  Spring equivalent: Aggregation.newAggregation(ops).withOptions(options)
`);
const fixedResults = db.invoices.aggregate(topRegionsPipeline, {
  allowDiskUse: true,
  comment: COMMENT,
  maxTimeMS: 30000,
}).toArray();
printjson(fixedResults);

section("STEP 3 — maxTimeMS proves the server enforces timeouts", `
  When maxTimeMS is sent, MongoDB aborts slow queries.
  Spring /options/maxtime-trap shows the opposite: discarded maxTime = query still runs.
`);
try {
  db.invoices.aggregate(topRegionsPipeline, { maxTimeMS: 1 }).toArray();
  print("Unexpected: query completed within 1ms");
} catch (e) {
  print("Expected — server rejected query:");
  print("  " + e.message);
}

section("STEP 4 — currentOp finds queries by comment (admin DB only)", `
  comment appears in currentOp and profiler — use it in production.
  Run this while a slow query is in flight; 0 results is normal for fast demos.

  use admin
  db.aggregate([
    { $currentOp: { allUsers: true } },
    { $match: { "command.comment": /invoice-analytics/ } }
  ])
`);
const ops = db.getSiblingDB("admin").aggregate([
  { $currentOp: { allUsers: true, idleConnections: true } },
  { $match: { "command.comment": COMMENT } },
]).toArray();
print(`Active ops with comment '${COMMENT}': ${ops.length}`);

section("Spring endpoint mapping", `
  GET /options/broken          pipeline.withOptions(opts);  // NO-OP
  GET /options/fixed           .withOptions(opts) chained
  GET /options/maxtime-trap    1ms maxTime discarded
  GET /options/raw-driver-trap toPipeline() drops options
`);
