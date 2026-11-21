import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";

const out = path.resolve(".test-results");
await mkdir(out, { recursive: true });
const dir = await mkdtemp(path.join(out, "history-"));
process.env.LMM_DATA_DIR = dir;
const live = process.argv.includes("--live");
const { getQuote, createQuote } = await import("../apps/web/lib/quotes.ts");
const { changeWorkflow, getQuoteReview, getApprovedPackage } = await import("../apps/web/lib/workflow.ts");
const { saveJob, parseActualsCsv, getJob } = await import("../apps/web/lib/jobs.ts");
const { getEstimatingSettings, saveEstimatingSettings, suggestOperations, applyOperations } =
  await import("../apps/web/lib/estimating.ts");
const {
  historyContext,
  generateHistory,
  applyHistory,
  decideProposal,
  listProposals,
  historyArchive,
  appliedEvidence,
} = await import("../apps/web/lib/history.ts");
const itemId = "test-plate";
const templateId = "plate-fab";
function newDraft(jobName, quantity) {
  return createQuote({
    customer: "Fixture Manufacturing",
    jobName,
    notes: "Local verification",
    marginPercent: 25,
    items: [
      {
        id: itemId,
        description: "Support plate\nMaterial / grade: A36\nDimensions: 120 x 80\nUnits: mm",
        quantity,
        costRows: [{ id: "manual", label: "Handling", amount: 1, rate: 3, basis: "batch" }],
      },
    ],
  });
}
const first = newDraft("Support plates · completed batch", 10);
const base = suggestOperations(first.id, itemId, templateId);
const priced = applyOperations(first.id, { ...base, itemId, templateId });
let view = getQuoteReview(first.id);
const details = {
  ...view.snapshot.details,
  scope: "Fabricate and deburr 10 support plates.",
  leadTime: "Five shop days",
  terms: "Net 30",
  scopeConfirmed: true,
  leadTimeConfirmed: true,
};
for (const q of view.snapshot.questions) details.resolutions[q.id] = "Customer confirmed.";
view = await changeWorkflow(first.id, {
  action: "submit",
  version: priced.version,
  drawingId: null,
  details,
});
const v = view.currentVersion;
await changeWorkflow(first.id, { action: "approve", version: v, drawingId: null });
const historical = getApprovedPackage(first.id, v);
const csv =
  'line,category,operation,amount,unit,unit_cost\n1,setup,Set up and lay out,0.5,h,60\n1,labor,Fabricate and deburr,2,h,60\n1,machine,Drill press,0.8,h,40\n1,material,"A36 plate, cut",10,piece,8.25';
const imported = parseActualsCsv(csv, historical.quote);
assert.equal(imported[3].operation, "A36 plate, cut");
assert.throws(() => parseActualsCsv(csv.replace("0.5,h", "-1,h"), historical.quote), /CSV row/);
const job = saveJob(first.id, v, {
  edit: 0,
  rows: [
    ...imported,
    { itemId, kind: "outside", operation: "Delivery", amount: 1, unit: "trip", unitCost: 35 },
  ],
  scopeChanges: "Delivery added after approval.",
  overrideReasons: "Fixture setup took half an hour.",
  completedOn: "2026-11-01",
});
assert.equal(getJob(first.id, v).rows.length, 5);
assert.throws(() => saveJob(first.id, v, { ...job, edit: 0 }), /another window/);
const rates = getEstimatingSettings();
rates.rates.find((r) => r.id === "fab-labor").value = 80;
saveEstimatingSettings(rates);
const next = newDraft("Support plates · repeat order", 20);
const ctx = await historyContext(next.id, itemId, templateId);
assert.equal(ctx.records[0].version, v);
assert.equal(ctx.records[0].actuals[1].amount, 2);
assert.ok(ctx.records[0].reasons.some((s) => s.includes("dimensions")));
assert.ok(ctx.records[0].reasons.some((s) => s.includes("material")));
let server;
if (!live) {
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const payload = JSON.parse(JSON.parse(text).messages[1].content[0].text);
    assert.equal(payload.examples[0].actualBatchTotals.find((r) => r.kind === "labor").amount, 2);
    assert.equal(payload.template.operations.length, 3);
    assert.equal(payload.operations[0].anchorHours, 0.5);
    assert.equal(payload.operations[1].anchorHours, 0.2);
    const data = {
      op1: { factor: 1, confidence: 0.8, assumption: "Same fixture", basis: "Same shop setup.", sources: ["R1"] },
      op2: {
        factor: 1, confidence: 0.8,
        assumption: "Same deburring",
        basis: "Same grade, size and edge finish.",
        sources: ["R1"],
      },
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data) } }],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.VISION_PROVIDER = "llama.cpp";
  process.env.VISION_MODEL = "local-test-fixture";
  process.env.VISION_BASE_URL = "http://127.0.0.1:" + server.address().port + "/v1";
}
try {
  const run = await generateHistory(next.id, itemId, templateId);
  console.log("Provider", run.provider, run.model, "returned", JSON.stringify(run.advice));
  assert.equal(run.records[0].quoteId, first.id);
  assert.ok(
    run.advice.some((a) => a.sources.includes("R1")),
    "At least one suggested operation must use the completed job",
  );
  assert.match(run.advice[1].basis, /2 h for 10 parts. 0.2 h per part/);
  assert.equal(getQuote(next.id).version, next.version, "AI never writes quote directly");
  const edits = run.advice.map((a) => ({
    ...a,
    hours: a.operationId === "layout" ? 0.6 : 0.25,
    assumption: "Similar workholding",
    reason:
      a.operationId === "layout"
        ? "Shared fixture across repeat runs"
        : "Extra hand finishing for this batch",
    recurring: a.operationId === "layout",
  }));
  const quoted = applyHistory(next.id, run.id, edits);
  assert.equal(quoted.totals.estimatedCost, 599); // handling 3 + blanks 160 + setup 36 + labor 400
  assert.equal(quoted.totals.sellingPrice, 798.67);
  assert.equal(quoted.items[0].costRows.find((r) => r.estimate?.operationId === "finish").rate, 80);
  assert.ok(
    appliedEvidence(quoted)[0].href.endsWith(run.id),
    "Staff review links directly to the supporting estimate",
  );
  assert.equal(
    getApprovedPackage(first.id, v).quote.items[0].costRows.find(
      (r) => r.estimate?.operationId === "finish",
    ).rate,
    60,
  );
  assert.throws(() => applyHistory(next.id, run.id, edits), /already been applied/);
  const proposal = listProposals(run.id)[0];
  assert.equal(proposal.status, "pending");
  assert.equal(getEstimatingSettings().templates[0].operations[1].amount, 0.25);
  assert.equal(decideProposal(next.id, proposal.id, true)[0].status, "approved");
  const changed = getEstimatingSettings().templates[0];
  assert.equal(changed.operations[1].amount, 0.6);
  assert.equal(changed.operations[2].amount, 0.1);
  assert.equal(historyArchive(next.id, itemId, templateId, run.id).run.appliedVersion, quoted.version);
  if (!live) {
    const late = await generateHistory(next.id, itemId, templateId);
    saveEstimatingSettings(getEstimatingSettings());
    assert.throws(() => applyHistory(next.id, late.id, edits), /changed/);
  }
  await writeFile(
    path.join(dir, "verification.json"),
    JSON.stringify(
      { first: first.id, version: v, next: next.id, itemId, templateId, run: run.id },
      null,
      2,
    ),
  );
  console.log(
    "Verified approved and completed supporting records, CSV and manual actuals, one-time exception, approved recurring change, current rates, and preserved historical price.\n" +
      dir,
  );
} finally {
  server?.close();
}
