import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

mkdirSync(".test-results", { recursive: true });
process.env.LMM_DATA_DIR = mkdtempSync(path.resolve(".test-results/learning-export-"));
const exp = await import("../apps/web/lib/learning-export.ts");
const { getDb } = await import("../apps/web/lib/db.ts");
const { getQuote, updateQuote } = await import("../apps/web/lib/quotes.ts");
const { getDrawingState } = await import("../apps/web/lib/drawings.ts");
const { getEstimatingSettings, saveEstimatingSettings } = await import("../apps/web/lib/estimating.ts");
const { changeWorkflow, getQuoteReview, getApprovedPackage } = await import("../apps/web/lib/workflow.ts");
const { extractReview, editReview } = await import("../apps/web/lib/reviews.ts");
const { fieldKeys } = await import("../apps/web/lib/review-types.ts");
const { saveJob } = await import("../apps/web/lib/jobs.ts");
const { importEmail } = await import("../apps/web/lib/email/import.ts");
const workspace = exp.getLearningWorkspaceId();
assert.match(workspace, /^[0-9a-f-]{36}$/);
const acknowledgeAll = () => {
  for (const p of exp.getPendingLearningEntities()) exp.acknowledgeLearningEntity(p.key, p.generation);
};
acknowledgeAll();
const rates = getEstimatingSettings();
saveEstimatingSettings(rates);
assert.ok(
  exp.getPendingLearningEntities().some((p) => p.key === "shop"),
  "Later-created rate table must be tracked",
);
assert.ok(
  exp.exportLearningEntity("shop").records.filter((r) => r.kind === "shop_rate").length >=
    rates.rates.length * 2,
);
const eml = Buffer.from(
  readFileSync("fixtures/mail/request.eml", "utf8").replaceAll(
    "fp108-A@ridgeline.example",
    "export-test@fixture.example",
  ),
);
const imported = await importEmail(eml);
const quoteId = imported.quoteId,
  key = "quote:" + quoteId;
assert.equal((await importEmail(eml)).duplicate, true);
const q = getQuote(quoteId),
  line = q.items[0];
const revision = getDrawingState(quoteId).selectedRevisionId;
const fields = Object.fromEntries(
  fieldKeys.map((k) => [
    k,
    {
      status: "found",
      value: k === "quantity" ? "6" : k,
      evidence: [{ page: 1, excerpt: "Test-source " + k }],
    },
  ]),
);
const run = await extractReview(quoteId, revision, q.version, async () => ({
  parts: [{ fields }],
  model: "fixture",
  provider: "fixture",
  raw: "unaltered raw provider text",
}));
editReview(quoteId, revision, {
  runId: run.id,
  editVersion: run.editVersion,
  action: "apply",
  corrections: [{ selected: true, targetItemId: line.id, values: { material: "A36" } }],
});
const draft = getQuote(quoteId);
updateQuote(quoteId, {
  ...draft,
  items: [
    {
      ...draft.items[0],
      costRows: [{ id: "cost", label: "Setup", amount: 1, rate: 60, basis: "batch" }],
    },
  ],
});
let review = getQuoteReview(quoteId);
const details = {
  ...review.snapshot.details,
  scope: "Six A36 parts",
  scopeConfirmed: true,
  leadTime: "Two weeks",
  leadTimeConfirmed: true,
  terms: "Net 30",
  pricingDecision: { kind: "standard", reason: "Include standard setup hours." },
};
for (const question of review.snapshot.questions)
  details.resolutions[question.id] = "Customer confirmed.";
review = await changeWorkflow(quoteId, {
  action: "submit",
  version: review.currentVersion,
  drawingId: revision,
  details,
});
await changeWorkflow(quoteId, {
  action: "approve",
  version: review.currentVersion,
  drawingId: revision,
});
saveJob(quoteId, review.currentVersion, {
  edit: 0,
  completedOn: "2026-11-01",
  scopeChanges: "",
  overrideReasons: "",
  rows: [{ kind: "setup", operation: "Setup", amount: 1.5, unit: "h", unitCost: 60, itemId: line.id }],
});

const batch = exp.exportLearningEntity(key);
const kinds = new Set(batch.records.map((r) => r.kind));
for (const kind of [
  "quote",
  "quote_version",
  "drawing_revision",
  "drawing_selection",
  "request_message",
  "message_attachment",
  "review_run",
  "review_edit",
  "applied_specification",
  "confirmed_specification",
  "workflow_version",
  "completed_job_edit",
  "quote_event",
])
  assert.ok(kinds.has(kind), kind);
assert.equal(
  batch.records.find((r) => r.kind === "review_run").data.raw_result,
  "unaltered raw provider text",
);
assert.deepEqual(batch.records.find((r) => r.kind === "confirmed_specification").data.fields.material, {
  value: "A36",
  corrected: true,
  extractedStatus: "found",
  evidence: [{ page: 1, excerpt: "Test-source material" }],
});
const approved = batch.records.find((r) => r.kind === "workflow_version" && r.data.approved_at).data;
function bytes(ref) {
  return batch.files.find((f) => f.sha256 === ref.sha256).bytes;
}
assert.deepEqual(bytes(approved.customer_pdf), getApprovedPackage(quoteId, review.currentVersion).pdf);
assert.deepEqual(bytes(batch.records.find((r) => r.kind === "request_message").data.raw), eml);
const original = batch.records.find((r) => r.kind === "drawing_revision").data.original;
assert.equal(
  original.sha256,
  batch.records.find((r) => r.kind === "message_attachment").data.original.sha256,
);
for (const file of batch.files)
  assert.equal(createHash("sha256").update(file.bytes).digest("hex"), file.sha256);
assert.equal(batch.candidates[0].actuals[0].amount, 1.5);
assert.equal(batch.candidates[0].pricing.approvedSellingPrice, 80);
assert.equal(batch.candidates[0].pricing.firstSellingPrice, 0);
const db = getDb();
db.prepare("INSERT INTO mail_account (id,sender,sealed_refresh) VALUES (1,?,?)").run(
  "owner@fixture.example",
  "secret-fixture-never-export",
);
assert.ok(
  !JSON.stringify(exp.exportLearningEntity(key).records).includes("secret-fixture-never-export"),
);
acknowledgeAll();
const before = exp.exportLearningEntity(key);
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE quotes SET updated_at=updated_at WHERE id=?").run(quoteId);
db.exec("ROLLBACK");
assert.equal(exp.getLearningSyncCounts().pending, 0);
db.prepare("UPDATE quotes SET updated_at=updated_at WHERE id=?").run(quoteId);
exp.acknowledgeLearningEntity(key, before.generation);
assert.ok(
  exp.getPendingLearningEntities().some((p) => p.key === key && p.generation > before.generation),
);
acknowledgeAll();
exp.requestLearningBackfill();
assert.deepEqual(exp.getLearningSyncCounts(), { total: 3, pending: 3 });
db.close();
delete globalThis.lmmDb;
assert.equal(exp.getLearningWorkspaceId(), workspace);
assert.deepEqual(exp.getLearningSyncCounts(), { total: 3, pending: 3 });
console.log(
  "Verified durable queue/backfill/restart, stale acknowledgment and rollback, original file hashes, credential exclusions, confirmed specs, signed-off PDF, shop price history and first-draft vs approval vs actuals.",
);
