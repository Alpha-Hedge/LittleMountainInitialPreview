import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { getDb } from "./db";
import { getDrawingRevision, getDrawingState } from "./drawings";
import { getQuote, QuoteError, updateQuote } from "./quotes";
import { fieldKeys, fieldLabels, type FieldKey, type PartCorrection, type ReviewPart, type ReviewRun } from "./review-types";
import type { Quote } from "./types";

type VisionReader = (
  revision: { bytes: Buffer; fileName: string; mimeType: string },
  notes: string,
) => Promise<{ provider: string; model: string; raw: string; parts: ReviewPart[] }>;

const initialized = new WeakSet<DatabaseSync>();

function storage(quoteId: string, revisionId: string) {
  const drawings = getDrawingState(quoteId);
  if (!drawings.attachments.some((attachment) => attachment.revisions.some((revision) => revision.id === revisionId))) {
    throw new QuoteError("Drawing revision not found on this quote.", 404);
  }
  const db = getDb();
  if (!initialized.has(db)) {
    // Model output and each edit are immutable. Save/apply append new events.
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_runs (
        id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id),
        revision_id TEXT NOT NULL REFERENCES drawing_revisions(id), quote_version INTEGER NOT NULL,
        notes TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, raw_result TEXT NOT NULL,
        parts TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_by_revision ON review_runs(quote_id, revision_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS review_edits (
        run_id TEXT NOT NULL REFERENCES review_runs(id), version INTEGER NOT NULL,
        corrections TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS review_one_apply ON review_edits(run_id) WHERE action = 'apply';
      CREATE TABLE IF NOT EXISTS review_applied_items (
        run_id TEXT NOT NULL REFERENCES review_runs(id), part_index INTEGER NOT NULL, item_id TEXT NOT NULL,
        source_identity TEXT NOT NULL, PRIMARY KEY (run_id, part_index)
      );
    `);
    if (!db.isTransaction) initialized.add(db);
  }
  return db;
}

function atomic<T>(db: DatabaseSync, action: () => T): T {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT quote_review" : "BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec(nested ? "RELEASE quote_review" : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO quote_review; RELEASE quote_review" : "ROLLBACK");
    throw error;
  }
}

const currentRuns = `
  SELECT r.id, r.quote_id, r.revision_id, r.quote_version, r.notes, r.provider, r.model, r.parts,
         r.created_at, e.version, e.corrections, CASE WHEN e.action = 'apply' THEN e.created_at END AS applied_at
  FROM review_runs r JOIN review_edits e ON e.run_id = r.id
  WHERE e.version = (SELECT MAX(last.version) FROM review_edits last WHERE last.run_id = r.id)
    AND r.quote_id = ? AND r.revision_id = ?
`;

function decode(row: Record<string, SQLOutputValue>): ReviewRun {
  return {
    id: String(row.id), quoteId: String(row.quote_id), revisionId: String(row.revision_id),
    quoteVersion: Number(row.quote_version), notes: String(row.notes), provider: String(row.provider),
    model: String(row.model), parts: JSON.parse(String(row.parts)), createdAt: String(row.created_at),
    editVersion: Number(row.version), corrections: JSON.parse(String(row.corrections)),
    appliedAt: row.applied_at === null ? null : String(row.applied_at),
  };
}

function findRun(db: DatabaseSync, quoteId: string, revisionId: string, runId: string): ReviewRun {
  const row = db.prepare(currentRuns + " AND r.id = ?").get(quoteId, revisionId, runId);
  if (!row) throw new QuoteError("Review not found for this drawing revision.", 404);
  return decode(row);
}

export function listReviews(quoteId: string, revisionId: string): ReviewRun[] {
  return storage(quoteId, revisionId)
    .prepare(currentRuns + " ORDER BY r.created_at DESC, r.rowid DESC")
    .all(quoteId, revisionId).map(decode);
}

function checkActive(quoteId: string, revisionId: string, version: unknown): Quote {
  const quote = getQuote(quoteId);
  if (!quote) throw new QuoteError("Quote not found.", 404);
  if (quote.version !== version) throw new QuoteError("The quote has changed. Run a new review from the latest saved draft.", 409);
  if (getDrawingState(quoteId).selectedRevisionId !== revisionId) {
    throw new QuoteError("Select this drawing revision on the quote before continuing.", 409);
  }
  return quote;
}

export async function extractReview(quoteId: string, revisionId: string, version: unknown, read: VisionReader) {
  if (typeof version !== "number" || !Number.isSafeInteger(version)) throw new QuoteError("Supply the saved quote version.");
  const db = storage(quoteId, revisionId);
  const quote = checkActive(quoteId, revisionId, version);
  const drawing = getDrawingRevision(quoteId, revisionId);
  if (!drawing) throw new QuoteError("Revision not found.", 404);
  const id = randomUUID();
  const started = new Date().toISOString();
  // Do not hold a database transaction during the network request. Its result
  // belongs to this snapshot even if another estimator saves during inference.
  const result = await read(drawing, quote.notes);
  return atomic(db, () => {
    db.prepare(`INSERT INTO review_runs
      (id, quote_id, revision_id, quote_version, notes, provider, model, raw_result, parts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, quoteId, revisionId, quote.version, quote.notes, result.provider, result.model, result.raw,
      JSON.stringify(result.parts), started,
    );
    const corrections = result.parts.map(() => ({ selected: true, values: {} }));
    db.prepare("INSERT INTO review_edits VALUES (?, 1, ?, 'extract', ?)").run(id, JSON.stringify(corrections), started);
    return findRun(db, quoteId, revisionId, id);
  });
}

// The sketch workspace has already verified these specs against the original photo.
// Register the generated drawing through the same applied-review path pricing uses.
export function applyConfirmedShopDrawing(
  quoteId: string,
  revisionId: string,
  items: { itemId: string; part: ReviewPart }[],
  source: { sketchId: string; sketchVersion: number },
) {
  const db = storage(quoteId, revisionId);
  return atomic(db, () => {
    const quote = getQuote(quoteId);
    if (!quote) throw new QuoteError("Quote not found.", 404);
    checkActive(quoteId, revisionId, quote.version);
    const runId = randomUUID();
    const at = new Date().toISOString();
    const corrections = items.map(({ itemId }) => ({ selected: true, values: {}, targetItemId: itemId }));
    db.prepare(`INSERT INTO review_runs
      (id, quote_id, revision_id, quote_version, notes, provider, model, raw_result, parts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      runId, quoteId, revisionId, quote.version, quote.notes, "Shop drawing", "Confirmed sketch",
      JSON.stringify(source), JSON.stringify(items.map(({ part }) => part)), at,
    );
    db.prepare("INSERT INTO review_edits VALUES (?, 1, ?, 'extract', ?)").run(runId, JSON.stringify(corrections), at);
    applyParts(db, findRun(db, quoteId, revisionId, runId), corrections);
    db.prepare("INSERT INTO review_edits VALUES (?, 2, ?, 'apply', ?)").run(runId, JSON.stringify(corrections), at);
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCorrections(input: unknown, partCount: number): PartCorrection[] {
  if (!Array.isArray(input) || input.length !== partCount) throw new QuoteError("Review each part in the extraction.");
  return input.map((item) => {
    if (!record(item) || typeof item.selected !== "boolean" || !record(item.values)) {
      throw new QuoteError("Invalid part correction.");
    }
    const values: PartCorrection["values"] = {};
    for (const [key, value] of Object.entries(item.values)) {
      if (!(fieldKeys as readonly string[]).includes(key) || typeof value !== "string" || value.length > 4000) {
        throw new QuoteError("Enter a valid correction of up to 4000 characters for each field.");
      }
      values[key as FieldKey] = value.trim();
    }
    if (item.targetItemId != null && (typeof item.targetItemId !== "string" || !item.targetItemId || item.targetItemId.length > 128)) {
      throw new QuoteError("Select a valid target quote line.");
    }
    return { selected: item.selected, values, targetItemId: item.targetItemId ?? null };
  });
}

function effective(part: ReviewPart, correction: PartCorrection, key: FieldKey, index: number) {
  const field = part.fields[key];
  if (Object.hasOwn(correction.values, key)) return correction.values[key]!;
  if (field.status === "conflict") {
    throw new QuoteError(`Resolve the conflicting ${fieldLabels[key].toLowerCase()} for part ${index + 1}.`);
  }
  return field.status === "found" ? field.value.trim() : "";
}

function applyParts(db: DatabaseSync, run: ReviewRun, corrections: PartCorrection[]): Quote {
  const quote = checkActive(run.quoteId, run.revisionId, run.quoteVersion);
  if (!corrections.some((part) => part.selected)) throw new QuoteError("Select at least one part to apply.");
  const items = [...quote.items];
  const matchedTargets = new Set<string>();
  const previous = db.prepare(`SELECT a.source_identity, a.item_id FROM review_applied_items a
    JOIN review_runs r ON r.id = a.run_id WHERE r.quote_id = ? AND r.revision_id = ?`).all(run.quoteId, run.revisionId);
  const insert = db.prepare("INSERT INTO review_applied_items VALUES (?, ?, ?, ?)");
  corrections.forEach((correction, index) => {
    if (!correction.selected) return;
    const part = run.parts[index];
    const description = effective(part, correction, "description", index);
    const quantity = Number(effective(part, correction, "quantity", index));
    if (!description || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000_000) {
      throw new QuoteError(`Enter a description and a positive whole-number quantity for part ${index + 1}.`);
    }
    const details = fieldKeys.filter((key) => key !== "description" && key !== "quantity").flatMap((key) => {
      const value = effective(part, correction, key, index);
      return value ? [`${fieldLabels[key]}: ${value}`] : [];
    });
    const text = [description, ...details].join("\n");
    const sourceIdentity = JSON.stringify(["description", "material", "dimensions", "thickness"].map(
      (key) => part.fields[key as FieldKey].value.trim().replace(/\s+/g, " ").toLowerCase(),
    ));
    const targetId = correction.targetItemId;
    if (targetId) {
      const target = items.findIndex((item) => item.id === targetId);
      if (target < 0 || matchedTargets.has(targetId)) throw new QuoteError("Select a different existing quote line for each part.");
      items[target] = { ...items[target], description: text, quantity };
      matchedTargets.add(targetId);
      insert.run(run.id, index, targetId, sourceIdentity);
    } else {
      if (previous.some((entry) => entry.source_identity === sourceIdentity && items.some((item) => item.id === entry.item_id))) {
        throw new QuoteError(`Part ${index + 1} was already applied from this revision. Select its existing quote line to update it.`, 409);
      }
      const id = randomUUID();
      items.push({ id, description: text, quantity, costRows: [] });
      insert.run(run.id, index, id, sourceIdentity);
    }
  });
  return updateQuote(run.quoteId, { ...quote, items });
}

export function editReview(quoteId: string, revisionId: string, body: unknown): { run: ReviewRun; quote?: Quote } {
  if (!record(body) || (body.action !== "save" && body.action !== "apply") || typeof body.runId !== "string" ||
      typeof body.editVersion !== "number" || !Number.isSafeInteger(body.editVersion)) {
    throw new QuoteError("Select a review and supply its edit version.");
  }
  const { action, runId, editVersion } = body;
  const db = storage(quoteId, revisionId);
  return atomic(db, () => {
    const run = findRun(db, quoteId, revisionId, runId);
    if (run.appliedAt) throw new QuoteError("This review has already been applied.", 409);
    if (run.editVersion !== editVersion) throw new QuoteError("The review has newer corrections. Reopen it before saving.", 409);
    const corrections = parseCorrections(body.corrections, run.parts.length);
    const quote = action === "apply" ? applyParts(db, run, corrections) : undefined;
    db.prepare("INSERT INTO review_edits VALUES (?, ?, ?, ?, ?)").run(
      run.id, editVersion + 1, JSON.stringify(corrections), action, new Date().toISOString(),
    );
    return { run: findRun(db, quoteId, revisionId, runId), quote };
  });
}
