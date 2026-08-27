// Backward-compatible entry point — delegates to scripts/seed-invoices.mongosh.js
// Usage: mongosh mongodb://localhost:27017/mongo_demo seed.js

load("scripts/seed-invoices.mongosh.js");
