import { readFileSync, writeFileSync } from "node:fs";

const p = process.argv[2];
if (p === undefined) {
  console.error("usage: node fix-session.mjs <session-json-path>");
  process.exit(1);
}
const existing = (() => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
})();
const next = { ...existing, asked: true, diffused: true, greeted: true, updatedAt: new Date().toISOString() };
// UTF-8 without BOM
writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
console.log(JSON.stringify(next));
