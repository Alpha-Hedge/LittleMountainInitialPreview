import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";

const cloud = process.argv.includes("--cloud"),
  live = process.argv.includes("--live");
const output = path.resolve(".test-results");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "learning-qa-"));
process.env.LMM_DATA_DIR = directory;
if (cloud) {
  assert.ok(
    process.env.LMM_SUPABASE_READ_URL && process.env.LMM_SUPABASE_WRITE_URL,
    "Cloud verification requires the server environment",
  );
  process.env.LMM_SUPABASE_DATA_DIR = directory;
  process.env.LMM_SUPABASE_WORKSPACE_KIND = "verification";
  process.env.LMM_SUPABASE_WORKSPACE_LABEL = "Five-job setup estimate QA";
} else {
  delete process.env.LMM_SUPABASE_READ_URL;
  delete process.env.LMM_SUPABASE_WRITE_URL;
}
delete process.env.LMM_SUPABASE_SHARED_WORKSPACES;
process.env.VISION_PROVIDER = "llama.cpp";
process.env.VISION_BASE_URL = "http://127.0.0.1:8187/v1";
process.env.VISION_MODEL = live ? "Qwen3-VL-2B-Instruct" : "fixture";

const { createQuote, updateQuote, getQuote } = await import("../apps/web/lib/quotes.ts");
const { getEstimatingSettings, saveEstimatingSettings, suggestOperations, applyOperations } =
  await import("../apps/web/lib/estimating.ts");
const { getQuoteReview, changeWorkflow } = await import("../apps/web/lib/workflow.ts");
const { saveJob } = await import("../apps/web/lib/jobs.ts");
const { getLearningWorkspaceId } = await import("../apps/web/lib/learning-export.ts");
const { syncLearningHistory } = await import("../apps/web/lib/cloud-history.ts");
const { previewEstimate, generateHistory, listProposals, decideProposal } = await import(
  "../apps/web/lib/history.ts"
);
const { compareAllowances } = await import("../apps/web/lib/measured-allowances.ts");

const book = getEstimatingSettings();
const template = book.templates.find((t) => t.id === "plate-fab");
const operation = template.operations.find((o) => o.id === "layout");
operation.amount = 0.75;
template.operations = [operation];
saveEstimatingSettings(book);
const itemId = "qa-plate";
const testMinutes = [84, 87, 90, 93, 96, 900];
const sampleIds = [];
function draft(name) {
  return createQuote({
    customer: "QA · fixture customer",
    jobName: name,
    notes: "Verification data",
    marginPercent: 25,
    items: [
      {
        id: itemId,
        description: "Press fixture plate\nMaterial / grade: A36\nDimensions: 200 x 110\nUnits: mm",
        quantity: 10,
        costRows: [{ id: "blank", label: "Material", amount: 1, rate: 8, basis: "per_unit" }],
      },
    ],
  });
}
for (const [index, minutes] of testMinutes.entries()) {
  const quote = draft("QA · fixture batch " + (index + 1));
  const base = suggestOperations(quote.id, itemId, template.id);
  let priced = applyOperations(quote.id, { ...base, itemId, templateId: template.id });
  const kind = index === 0 ? "one_time" : index === 1 ? "recurring" : "standard";
  const reason =
    index === 0
      ? "One-time courtesy discount"
      : index === 1
        ? "Extra QA margin on certified repeat work"
        : "Standard setup and material.";
  if (index < 2) priced = updateQuote(quote.id, { ...priced, marginPercent: index === 0 ? 20 : 30 });
  const view = getQuoteReview(quote.id);
  const details = {
    ...view.snapshot.details,
    scope: "Ten fixture plates",
    leadTime: "Five business days",
    terms: "Net 30",
    scopeConfirmed: true,
    leadTimeConfirmed: true,
    pricingDecision: { kind, reason },
  };
  for (const q of view.snapshot.questions) details.resolutions[q.id] = "Confirmed by QA";
  const signed = await changeWorkflow(quote.id, {
    action: "submit",
    version: priced.version,
    drawingId: null,
    details,
  });
  const version = signed.currentVersion;
  await changeWorkflow(quote.id, { action: "approve", version, drawingId: null });
  const exceptionReason = index === 5 ? "One-off press breakdown" : "";
  saveJob(quote.id, version, {
    edit: 0,
    completedOn: "2026-11-01",
    scopeChanges: "",
    overrideReasons: exceptionReason,
    rows: [
      {
        itemId,
        kind: "setup",
        operation: operation.label,
        amount: minutes / 60,
        unit: "h",
        unitCost: 60,
        exceptionReason,
      },
    ],
  });
  sampleIds.push(quote.id);
}
const target = draft("QA · next fixture estimate");
const view = await previewEstimate(target.id, itemId, template.id);
assert.equal(view.comparison?.source, cloud ? "Supabase" : "Local", view.comparisonError);
const obs = view.comparison.observations[0];
assert.equal(obs.templateHours, 0.75);
assert.equal(obs.observedHours, 1.5);
assert.equal(obs.samples.length, 5);
assert.ok(obs.recurring);
assert.equal(view.comparison.preferences.length, 1);
assert.equal(view.comparison.preferences[0].approvedMarginPercent, 30);
assert.equal(view.comparison.preferences[0].reason, "Extra QA margin on certified repeat work");
const measuredReview = await generateHistory(target.id, itemId, template.id, "template_review");
assert.equal(measuredReview.provider, "Completed jobs");
assert.equal(measuredReview.advice.length, 0);
assert.equal(listProposals(measuredReview.id)[0].after, 1.5);
assert.equal(
  getEstimatingSettings().templates.find((t) => t.id === template.id).operations[0].amount,
  0.75,
);
let server;
if (!live) {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(JSON.parse(body).messages[1].content[0].text);
    assert.equal(payload.operations[0].anchorHours, 1.5);
    assert.equal(payload.approvedRecurringPricingPreferences.length, 1);
    assert.ok(payload.examples.some((r) => r.approvedPricing.decision.kind === "one_time"));
    assert.ok(
      payload.examples.some((r) => r.actualBatchTotals[0].exceptionReason === "One-off press breakdown"),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                op1: {
                  factor: 1, confidence: 0.9,
                  assumption: "Repeat workholding",
                  basis: "Comparable work",
                  sources: payload.operations[0].sources,
                },
              }),
            },
          },
        ],
      }),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.VISION_BASE_URL = "http://127.0.0.1:" + server.address().port + "/v1";
}
try {
  const run = await generateHistory(target.id, itemId, template.id);
  assert.equal(run.recordsSource, cloud ? "Supabase" : "Local");
  assert.equal(run.observations[0].samples.length, 5);
  assert.equal(run.observations[0].observedHours, 1.5);
  assert.equal(run.records.find((r) => r.quoteId === sampleIds[0]).pricing.decision.kind, "one_time");
  assert.equal(getQuote(target.id).version, 1);
  const duplicates = Array(5).fill(run.records.find((r) => r.quoteId === sampleIds[0]));
  assert.equal(
    compareAllowances(run.base.rows, duplicates)[0].recurring,
    false,
    "Repeated revisions of one job cannot supply five observations",
  );
  const proposal = listProposals(run.id)[0];
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.before, 0.75);
  assert.equal(proposal.after, 1.5);
  assert.equal(
    getEstimatingSettings().templates.find((t) => t.id === template.id).operations[0].amount,
    0.75,
  );
  const verified = {
    workspace: getLearningWorkspaceId(),
    target: target.id,
    itemId,
    templateId: template.id,
    run: run.id,
    proposal: proposal.id,
    directory,
  };
  if (!process.argv.includes("--leave-pending")) {
    decideProposal(target.id, proposal.id, true);
    assert.equal(suggestOperations(target.id, itemId, template.id).rows[0].amount, 1.5);
    assert.equal(getQuote(target.id).version, 1);
  }
  await writeFile(path.join(directory, "verification.json"), JSON.stringify(verified, null, 2));
  if (cloud) await syncLearningHistory();
  console.log(
    "Verified " +
      run.recordsSource +
      " history and " +
      (live ? "live local AI" : "fixture AI") +
      ". Five measured jobs yielded 90 min versus 45 min configured. One-time breakdown excluded. One-time discount and recurring margin tagged separately.",
  );
  console.log(JSON.stringify(verified));
} finally {
  server?.close();
}
