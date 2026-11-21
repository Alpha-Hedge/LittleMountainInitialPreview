import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./test-typescript.mjs";

const folder = mkdtempSync(path.join(tmpdir(), "lmm-estimating-"));
process.env.LMM_DATA_DIR = folder;
const { getDb } = await import("../apps/web/lib/db.ts");
const { getQuote, getQuoteVersion, listQuoteVersions, updateQuote } = await import("../apps/web/lib/quotes.ts");
const { getEstimatingSettings, saveEstimatingSettings, suggestOperations, applyOperations } = await import("../apps/web/lib/estimating.ts");
const { getDrawingState, uploadDrawing } = await import("../apps/web/lib/drawings.ts");
const { extractReview, editReview } = await import("../apps/web/lib/reviews.ts");
const { fieldKeys } = await import("../apps/web/lib/review-types.ts");
const db = getDb();
const id = "legacy-plate";
const itemId = "first-item";
const draft = { customer: "Test customer", jobName: "Test drill pattern", notes: "", marginPercent: 25,
  items: [{ id: itemId, description: "Fixture", quantity: 10, costRows: [{ id:"freight",label:"Local delivery",amount:1,rate:30,basis:"batch" }] }] };

try {
  // Simulate a database that had no history table when the estimator was installed.
  db.prepare("INSERT INTO quotes VALUES(?,1,7,?,?,?)").run(id, JSON.stringify(draft), "2026-01-01", "2026-01-01");
  assert.equal(getQuote(id).totals.sellingPrice, 40);
  assert.deepEqual(listQuoteVersions(id).map(q => q.version), [7]);
  assert.equal(getQuoteVersion(id, 6), null);
  const templateId = "drilled-plate";
  const body = s => ({...s, itemId, templateId, keepManual:true});
  const unknown = suggestOperations(id, itemId, templateId);
  assert.deepEqual(unknown.missingOperationIds, ["drilling"]);
  assert.throws(() => applyOperations(id, body(unknown)), /Explain the manual allowance/);
  assert.deepEqual(listQuoteVersions(id).map(q => q.version), [7]);

  const bytes = readFileSync(new URL("../fixtures/drawings/bracket-set-incomplete.pdf", import.meta.url));
  const rev = uploadDrawing(id, {bytes, fileName:"fixture.pdf"}, "", "A").selectedRevisionId;
  const fields = Object.fromEntries(fieldKeys.map(k => [k, { status:"missing", value:"", evidence:[] }]));
  for (const [key, value] of Object.entries({description:"Drilled plate", quantity:"10", dimensions:"300 x 200 mm", requirements:"3 holes"})) {
    fields[key] = {status:"found", value, evidence:[{page:1,excerpt:value}]};
  }
  const run = await extractReview(id, rev, 7, async () => ({provider:"fixture",model:"manual-checked",raw:"deterministic test",parts:[{fields}]}));
  editReview(id, rev, {runId:run.id,editVersion:1,action:"apply",corrections:[{selected:true,targetItemId:itemId,values:{requirements:"4 holes"}}]});
  const suggestion = suggestOperations(id, itemId, templateId);
  assert.equal(suggestion.reviewRunId, run.id);
  assert.deepEqual(suggestion.missingOperationIds, []);
  const drilling = suggestion.rows[1];
  assert.equal(drilling.amount, .2);
  assert.match(drilling.estimate.rationale, /Reviewed hole count 4/);
  const suggested = applyOperations(id, body(suggestion));
  assert.equal(suggested.totals.estimatedCost, 125); // $30 freight, $15 setup, 10 × 0.2 × $40.
  assert.equal(suggested.totals.sellingPrice, 166.67);
  const edit = suggestOperations(id, itemId, templateId);
  edit.rows[1].amount = .003;
  assert.throws(() => applyOperations(id, body(edit)), /Explain the manual allowance/);
  edit.rows[1].estimate.overrideReason = "Customer supplies a prepared drilling jig.";
  const approvedInputs = applyOperations(id, body(edit));
  assert.equal(approvedInputs.totals.estimatedCost, 50); // $30 freight + $15 setup + $5 minimum for the line.
  assert.equal(approvedInputs.totals.sellingPrice, 66.67);
  assert.equal(approvedInputs.items[0].costRows.length, 3);
  assert.equal(approvedInputs.items[0].costRows[2].estimate.baselineAmount,.2);
  assert.equal(approvedInputs.items[0].costRows[2].estimate.minimumCost,5);

  const oldSuggestion = suggestOperations(id,itemId,templateId);
  const settings = getEstimatingSettings();
  settings.rates.find(r => r.id === "drill-press").value = 100;
  settings.templates[1].operations.push({ id:"profile",label:"Profile the blank",rateId:"drill-press",amount:2,basis:"per_unit",driver:"area_m2",assumption:"Rectangular blank." });
  const changed = saveEstimatingSettings(settings);
  assert.equal(changed.version, 2);
  assert.throws(() => saveEstimatingSettings(settings), error => error.status === 409);
  assert.throws(() => applyOperations(id, body(oldSuggestion)), error => error.status === 409);
  const fresh = suggestOperations(id,itemId,templateId);
  assert.equal(fresh.rows[1].rate, 100);
  assert.equal(fresh.rows[2].amount,.12);
  assert.deepEqual(getQuoteVersion(id, approvedInputs.version), approvedInputs);
  assert.deepEqual(getQuoteVersion(id, suggested.version), suggested);
  assert.equal(getQuote(id).totals.sellingPrice, 66.67);
  assert.equal(getQuoteVersion(id, 7).totals.sellingPrice,40);
  assert.equal(getDrawingState(id).selectedRevisionId, rev);
  const manual = structuredClone(approvedInputs);
  const setup = manual.items[0].costRows[1];
  setup.amount = .5;
  assert.throws(() => updateQuote(id, manual), /Explain the manual allowance/);
  setup.estimate.overrideReason = "Operator requested an additional fixture.";
  setup.estimate.baselineAmount = 37; // The original server baseline survives normal client edits.
  const edited = updateQuote(id,manual);
  assert.equal(edited.totals.estimatedCost,65);
  assert.equal(edited.items[0].costRows[1].estimate.baselineAmount,.25);
  assert.equal(getQuoteVersion(id, approvedInputs.version).totals.estimatedCost,50);
  db.exec("BEGIN IMMEDIATE");
  updateQuote(id,{...getQuote(id),notes:"Uncommitted"});
  db.exec("ROLLBACK");
  assert.equal(listQuoteVersions(id)[0].version,edited.version);
  const ambiguousRun = await extractReview(id, rev, edited.version, async () => ({
    provider:"fixture",model:"ambiguous",raw:"range",parts:[{fields:{...fields,
      requirements:{status:"found",value:"4 to 6 holes",evidence:[{page:1,excerpt:"4 to 6 holes"}]}}}]
  }));
  editReview(id,rev,{action:"apply",runId:ambiguousRun.id,editVersion:1,corrections:[{selected:true,targetItemId:itemId,values:{}}]});
  assert.deepEqual(suggestOperations(id,itemId,templateId).missingOperationIds,["drilling"]);
  console.log("Passed legacy migration, selected drawing corrections, template hours, editable overrides, batch/quantity, one minimum per operation, settings conflicts, and immutable saved versions.");
} finally {
  db.close();
  rmSync(folder, {recursive:true, force:true});
}
