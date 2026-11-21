import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Run the production storage code in separate Node processes. The injected
// provider returns deterministic data, so the race tests need no network.
const script = fileURLToPath(import.meta.url);
const root = path.dirname(path.dirname(script));
const phase = process.argv[2];
if (!phase) {
  const directory = mkdtempSync(path.join(tmpdir(), "lmm-review-verification-"));
  try {
    for (const stage of ["write", "reopen"]) {
      execFileSync(process.execPath, [script, stage], {
        cwd: root, env: { ...process.env, LMM_DATA_DIR: directory }, stdio: "inherit", windowsHide: true,
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  assert.ok(["write", "reopen"].includes(phase) && process.env.LMM_DATA_DIR);
  await import("./test-typescript.mjs");

  const { fieldKeys } = await import("../apps/web/lib/review-types.ts");
  const { getQuote, updateQuote } = await import("../apps/web/lib/quotes.ts");
  const { getDrawingState, selectDrawingRevision, uploadDrawing } = await import("../apps/web/lib/drawings.ts");
  const { listReviews, extractReview, editReview } = await import("../apps/web/lib/reviews.ts");
  const { getDb } = await import("../apps/web/lib/db.ts");
  const quoteId = "demo-mounting-plate";
  const revisionId = getDrawingState(quoteId).selectedRevisionId;
  const note = "The customer confirmed a zinc finish.";
  const rawFixture = JSON.stringify({ source: "deterministic review verification" });

  if (phase === "reopen") {
    const runs = listReviews(quoteId, revisionId);
    assert.equal(runs.length, 3);
    const applied = runs.find((run) => run.appliedAt);
    assert.ok(applied);
    assert.equal(applied.corrections[1].values.finish, "zinc");
    assert.equal(applied.parts[1].fields.finish.status, "conflict");
    assert.equal(applied.parts[1].fields.quantity.status, "missing");
    assert.equal(getQuote(quoteId).notes, note);
    const original = getDb().prepare("SELECT raw_result FROM review_runs WHERE id = ?").get(applied.id);
    assert.ok(original.raw_result === rawFixture, "Original provider response must be preserved");
    const events = getDb().prepare("SELECT action FROM review_edits WHERE run_id = ? ORDER BY version").all(applied.id);
    assert.deepEqual(events.map((row) => row.action), ["extract", "save", "apply"]);
    console.log("Passed restart verification for the original result, reviewed values, and correction history.");
  } else {
    function part(name, quantity, conflictingFinish) {
      const fields = Object.fromEntries(fieldKeys.map((key) => [key, { status: "missing", value: "", evidence: [] }]));
      const drawingFact = (value) => ({ status: "found", value, evidence: [{ page: 1, excerpt: value }] });
      fields.description = drawingFact(name);
      fields.material = drawingFact("Steel");
      if (quantity) fields.quantity = drawingFact(quantity);
      if (conflictingFinish) fields.finish = {
        status: "conflict", value: "bare | zinc",
        evidence: [{ page: 1, excerpt: "bare" }, { page: null, excerpt: "zinc finish" }],
      };
      return { fields };
    }
    const original = {
      provider: "fixture", model: "two-part-fabrication-request", raw: rawFixture,
      parts: [part("Mounting plate", "10", false), part("Mounting tab", "", true)],
    };
    const { refineDrawingEvidence, applyExplicitNoteQuantities } = await import("../apps/web/lib/drawing-evidence.ts");
    const plate = part("Fixture plate", "6", false);
    const sheet = "Fixture plate 160 100 4X DIA 12 THRU 35 mm bore";
    plate.fields.dimensions = {
      status: "conflict", value: "160 mm | 100 mm",
      evidence: [
        { page: 1, excerpt: "The length of the fixture plate is 160 mm." },
        { page: 1, excerpt: "The width of the fixture plate is 100 mm." },
      ],
    };
    plate.fields.requirements = { status: "found", value: "35 mm bore", evidence: [{ page: 1, excerpt: "35 mm bore" }] };
    const [refined] = refineDrawingEvidence([plate], [sheet]);
    assert.equal(refined.fields.dimensions.value, "length 160 mm, width 100 mm");
    assert.equal(refined.fields.dimensions.status, "found");
    assert.equal(refined.fields.dimensions.evidence[0].verbatim, false);
    assert.equal(refined.fields.requirements.value, "35 mm bore\n4X DIA 12 THRU");
    assert.ok(refined.fields.requirements.evidence.every((evidence) => evidence.verbatim));
    assert.equal(refined.fields.quantity.evidence[0].verbatim, false); // The 6 in 160 is a different number.
    assert.equal(plate.fields.dimensions.status, "conflict"); // Preserve the original extraction.
    assert.equal(plate.fields.requirements.evidence[0].verbatim, undefined); // Older records still work.
    assert.deepEqual(refineDrawingEvidence([refined], [sheet])[0], refined);
    const [shared] = refineDrawingEvidence([plate, part("Second part", "1", false)], [sheet]);
    assert.equal(shared.fields.requirements.value, "35 mm bore");
    const competing = structuredClone(plate);
    competing.fields.dimensions.evidence[1].excerpt = "The length of the fixture plate is 100 mm.";
    assert.equal(refineDrawingEvidence([competing], [sheet])[0].fields.dimensions.status, "conflict");
    competing.fields.dimensions.evidence[1].excerpt = "100 mm";
    assert.equal(refineDrawingEvidence([competing], [sheet])[0].fields.dimensions.status, "conflict");
    const duplicate = structuredClone(plate);
    duplicate.fields.requirements.value = "4 × Ø12 mm through";
    assert.equal(refineDrawingEvidence([duplicate], [sheet])[0].fields.requirements.value, duplicate.fields.requirements.value);
    const spacer = part("Mounting spacer", "", false);
    const message = "Please quote 8 fixture plates and 12 mounting spacers.";
    const [orderedPlate, orderedSpacer] = applyExplicitNoteQuantities([plate, spacer], message);
    assert.deepEqual(orderedPlate.fields.quantity, {
      status: "conflict", value: "6 | 8",
      evidence: [{page:1, excerpt:"6"}, {page:null, excerpt:"8 fixture plates", verbatim:true}],
    });
    assert.equal(orderedSpacer.fields.quantity.value, "12");
    assert.deepEqual(applyExplicitNoteQuantities([orderedPlate, orderedSpacer], message), [orderedPlate, orderedSpacer]);
    assert.equal(plate.fields.quantity.value, "6");
    assert.equal(applyExplicitNoteQuantities([plate], "Quantity: 8 pcs.")[0].fields.quantity.value, "6 | 8");
    for (const ambiguous of ["6 to 8 fixture plates.", "Between 6 and 8 fixture plates.", "Item #8 fixture plates.", "Price: $8 fixture plates.", "8 mm fixture plates.", "Qty: 6–8", "Fixture plate qty: 8.5", "Qty: 8,500"]) {
      assert.deepEqual(applyExplicitNoteQuantities([plate], ambiguous), [plate]);
    }
    assert.deepEqual(applyExplicitNoteQuantities([plate,plate], message), [plate, plate]);
    assert.deepEqual(applyExplicitNoteQuantities([plate,spacer], "Qty: 8."), [plate,spacer]);
    console.log("Passed exact customer-quantity evidence, multi-part matching, conflict detection, and ambiguous-count exclusions.");
    console.log("Passed dimension-axis reconciliation, hole callout attribution, evidence verification, and ambiguity checks.");
    const readFixture = async () => structuredClone(original);
    const extract = (version, read = readFixture) => extractReview(quoteId, revisionId, version, read);
    const edit = (run, action, corrections = run.corrections) => editReview(quoteId, revisionId, {
      action, runId: run.id, editVersion: run.editVersion, corrections,
    });

    // Pause the first request while a manual quote edit and a newer extraction are saved.
    const delayed = Promise.withResolvers();
    const oldQuote = getQuote(quoteId);
    const pending = extract(oldQuote.version, () => delayed.promise);
    const updated = updateQuote(quoteId, { ...oldQuote, notes: note });
    const current = await extract(updated.version);
    const corrections = structuredClone(current.corrections);
    corrections[0].targetItemId = oldQuote.items[0].id;

    assert.throws(() => edit(current, "apply", corrections), /positive whole-number quantity/);
    corrections[1].values.quantity = "7";
    assert.throws(() => edit(current, "apply", corrections), /conflicting finish/);
    assert.deepEqual(getQuote(quoteId), updated);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS count FROM review_applied_items").get().count, 0);
    corrections[1].values.finish = "zinc";
    const { run: corrected } = edit(current, "save", corrections);
    assert.throws(() => edit(current, "save", corrections), (error) => error.status === 409);

    delayed.resolve(await readFixture());
    const oldRun = await pending;
    assert.equal(oldRun.notes, oldQuote.notes);
    assert.equal(oldRun.quoteVersion, oldQuote.version);
    assert.throws(() => edit(oldRun, "apply"), (error) => error.status === 409);
    assert.deepEqual(listReviews(quoteId, revisionId).find((run) => run.id === current.id), corrected);
    assert.deepEqual(getQuote(quoteId), updated);
    console.log("Passed delayed-response, optimistic-save, missing-quantity, and conflicting-finish checks.");

    const otherFile = {
      bytes: readFileSync(path.join(root, "fixtures", "drawings", "bracket-set-incomplete.pdf")),
      fileName: "bracket-set-incomplete.pdf",
    };
    const attachmentId = getDrawingState(quoteId).attachments[0].id;
    const otherRevision = uploadDrawing(quoteId, otherFile, attachmentId, "C").selectedRevisionId;
    assert.throws(() => edit(corrected, "apply"), (error) => error.status === 409);
    assert.deepEqual(listReviews(quoteId, otherRevision), []);
    selectDrawingRevision(quoteId, revisionId);
    const { quote, run: applied } = edit(corrected, "apply");
    assert.ok(applied.appliedAt);
    assert.equal(quote.items.length, 3);
    assert.deepEqual(quote.items[0].costRows, oldQuote.items[0].costRows);
    assert.deepEqual(quote.items[1], oldQuote.items[1]);
    assert.equal(quote.items[2].quantity, 7);
    assert.match(quote.items[2].description, /Finish: zinc/);
    assert.deepEqual(quote.items[2].costRows, []);
    assert.equal(quote.totals.estimatedCost, 200);
    assert.equal(quote.totals.sellingPrice, 266.67);
    assert.throws(() => edit(applied, "apply"), /already been applied/);
    const repeat = await extract(quote.version);
    corrections[0].targetItemId = null;
    assert.throws(() => edit(repeat, "apply", corrections), /already applied/);
    assert.deepEqual(getQuote(quoteId), quote);
    console.log("Passed exact-revision isolation, atomic apply, preserved manual costs, and duplicate-apply checks.");
  }
  getDb().close();
}
