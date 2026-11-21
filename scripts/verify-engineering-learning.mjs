import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import pg from "pg";

const directory = path.resolve(process.argv[2]);
const fixture = JSON.parse(await readFile(path.join(directory, "verification.json"), "utf8"));
const cfg = parseEnv(await readFile(".env.nfip-test", "utf8"));
assert.equal(cfg.NFIP_API_URL, "http://127.0.0.1:8141");
assert.ok(directory.startsWith(path.resolve(".test-results") + path.sep + "learning-qa-"));
Object.assign(process.env, {
  LMM_DATA_DIR: directory, LMM_SUPABASE_DATA_DIR: directory, LMM_SUPABASE_WORKSPACE_KIND: "verification",
  NFIP_ARCHIVE_DATA_DIR: directory, NFIP_API_URL: cfg.NFIP_API_URL, NFIP_API_TOKEN: cfg.NFIP_API_TOKEN,
});
delete process.env.LMM_SUPABASE_SHARED_WORKSPACES;
const { syncLearningHistory } = await import("../apps/web/lib/cloud-history.ts");
const { captureEngineeringLearning } = await import("../apps/web/lib/engineering-learning.ts");
const { blueprintLearningContext } = await import("../apps/web/lib/blueprint-history.ts");
const { getLearningWorkspaceId } = await import("../apps/web/lib/learning-export.ts");
assert.equal(getLearningWorkspaceId(), fixture.workspace);

const base = "/v1/learning/engineering";
async function api(route, body) {
  const response = await fetch(cfg.NFIP_API_URL + route, {
    method: body ? "POST" : "GET",
    headers: {Authorization: "Bearer " + cfg.NFIP_API_TOKEN, "Content-Type": "application/json"},
    body: body && JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data).slice(0, 500));
  return data;
}
const list = await api("/v1/blueprints/jobs?limit=100");
const candidate = list.find(j => j.state === "ready" && j.customer_name === "Blueprint acceptance fixture" && j.drawing.type === "CUSTOMER_PDF");
assert.ok(candidate, "Seed the isolated stack with python -m tests.blueprint_flow.");
let after = "blueprint:", found = false;
for (;;) {
  const entries = await api(base + "?limit=100&after=" + encodeURIComponent(after));
  if (!entries.length) break;
  for (const entry of entries) {
    if (entry.kind !== "blueprint") break;
    if (entry.id === candidate.id) {
      assert.equal(await captureEngineeringLearning(after, 1), entry.key);
      found = true;
      break;
    }
    after = entry.key;
  }
  if (found || entries.at(-1).kind !== "blueprint") break;
}
assert.ok(found, "Synthetic source should be available to the archive feed.");
await syncLearningHistory();
const client = new pg.Client({
  connectionString: process.env.LMM_SUPABASE_READ_URL,
  ssl: {ca: await readFile(process.env.LMM_SUPABASE_CA_FILE || "supabase/prod-ca.crt", "utf8"), rejectUnauthorized: true},
});
await client.connect();
try {
  const result = await client.query(
    "SELECT r.data,f.original,w.purpose FROM lmm_learning.records r JOIN lmm_learning.workspaces w ON w.id=r.workspace_id "
    + "JOIN lmm_learning.files f ON f.sha256=r.data->'source'->>'sha256' WHERE r.workspace_id=$1 AND r.entity_key=$2",
    [fixture.workspace, "engineering:blueprint:" + candidate.id],
  );
  assert.equal(result.rowCount, 1);
  const archived = result.rows[0];
  assert.equal(archived.purpose, "verification");
  assert.ok(archived.data.extraction.raw_response && archived.data.extraction.ast.parts.length);
  assert.equal(createHash("sha256").update(archived.original).digest("hex"), candidate.drawing.sha256);
} finally {
  await client.end();
}
const context = await blueprintLearningContext();
assert.equal(context.hosted_history_status, "supabase");
assert.ok(context.hosted_history.some(r => r.actuals.length && r.workspace === fixture.workspace));
const key = "/v1/blueprints/jobs/" + candidate.id;
const before = await api(key);
const revised = await api(key + "/review", {
  version: before.version, ast: before.ast, reason: "Isolated QA verifies hosted history and the frozen drawing.",
  confirmed: true, accepted_low_confidence: before.review_log.at(-1)?.accepted_low_confidence ?? [], ...context,
});
let finished;
for (let i = 0; i < 90; ++i) {
  finished = await api(key);
  if (finished.state !== "costing") break;
  await delay(400);
}
assert.equal(finished.version, revised.version);
assert.equal(finished.state, "ready", finished.error);
const history = finished.result.lines.flatMap(line => line.history).filter(x => x.source_workspace === fixture.workspace);
assert.ok(history.some(x => x.citation.excerpt.startsWith("Supabase") && x.actuals.length));
assert.equal(finished.result.totals.selling_price_usd, before.result.totals.selling_price_usd);
console.log("Verified original PDF bytes and raw extraction in Supabase and hosted actuals in a new Celery estimate. Frozen price unchanged.");
