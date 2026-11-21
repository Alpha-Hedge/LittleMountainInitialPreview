import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { getDb } from "../db";
import { DrawingError, uploadDrawing } from "../drawings";
import { drawingDraftCustomer } from "../quote-start";
import { createQuote, QuoteError } from "../quotes";
import { fieldKeys, type FieldKey, type ReviewPart } from "../review-types";
import { applyConfirmedShopDrawing } from "../reviews";
import { newQuoteDraft } from "../types";
import { getEstimatingSettings } from "../estimating";
import { compileShopFiles, type ShopFiles } from "./exports";
import { drawingIssues, partBounds } from "./geometry";
import { parseSketchDraft } from "./parse";
import { prepareSketchPhoto } from "./photo";
import { readSketch } from "./reader";
import {
  blankPart,
  type SketchDraft,
  type SketchJob,
  type SketchPart,
} from "./types";

let initialized = false;

function storage() {
  const db = getDb();
  if (!initialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sketch_jobs (
        id TEXT PRIMARY KEY, upload_token TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL, mime_type TEXT NOT NULL, original BLOB NOT NULL, preview BLOB NOT NULL,
        version INTEGER NOT NULL, draft TEXT NOT NULL, findings TEXT NOT NULL, questions TEXT NOT NULL,
        read_at TEXT, provider TEXT, model TEXT, raw_result TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sketch_revisions (
        sketch_id TEXT NOT NULL REFERENCES sketch_jobs(id), version INTEGER NOT NULL,
        draft TEXT NOT NULL, confirmed_at TEXT NOT NULL, quote_id TEXT REFERENCES quotes(id),
        PRIMARY KEY (sketch_id, version)
      );
      CREATE TABLE IF NOT EXISTS sketch_compilations (
        sketch_id TEXT NOT NULL, version INTEGER NOT NULL, bundle BLOB NOT NULL,
        PRIMARY KEY (sketch_id, version),
        FOREIGN KEY(sketch_id,version) REFERENCES sketch_revisions(sketch_id,version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sketch_revision_quote ON sketch_revisions(quote_id)
        WHERE quote_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS photo_release_quotes (
        source_id TEXT NOT NULL, revision INTEGER NOT NULL,
        quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id), PRIMARY KEY(source_id,revision)
      );
    `);
    initialized = true;
  }
  return db;
}

function write<T>(action: () => T): T {
  const db = storage();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const jobFields = `
  SELECT s.id, s.file_name, s.mime_type, s.version, s.draft, s.findings, s.questions,
    s.read_at, s.created_at, s.updated_at, v.confirmed_at, v.quote_id
  FROM sketch_jobs s LEFT JOIN sketch_revisions v ON v.sketch_id = s.id AND v.version = s.version
`;

function job(row: Record<string, SQLOutputValue>): SketchJob {
  return {
    id: String(row.id),
    fileName: String(row.file_name),
    mimeType: row.mime_type as SketchJob["mimeType"],
    version: Number(row.version),
    draft: JSON.parse(String(row.draft)),
    findings: JSON.parse(String(row.findings)),
    questions: JSON.parse(String(row.questions)),
    confirmed: row.confirmed_at !== null,
    linkedQuoteId: row.quote_id === null ? null : String(row.quote_id),
    readAt: row.read_at === null ? null : String(row.read_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listSketches() {
  return storage()
    .prepare(jobFields + " ORDER BY s.updated_at DESC, s.rowid DESC")
    .all()
    .map(job);
}

export function getSketch(id: string) {
  const row = storage()
    .prepare(jobFields + " WHERE s.id = ?")
    .get(id);
  if (!row) throw new QuoteError("Sketch not found.", 404);
  return job(row);
}

export function getSketchPhoto(id: string, original = false) {
  const row = storage()
    .prepare(
      `SELECT file_name, mime_type, ${original ? "original" : "preview"} AS bytes FROM sketch_jobs WHERE id = ?`,
    )
    .get(id);
  if (!row) throw new QuoteError("Sketch not found.", 404);
  return {
    bytes: Buffer.from(row.bytes as Uint8Array),
    mimeType: original ? String(row.mime_type) : "image/jpeg",
    fileName: original ? String(row.file_name) : "sketch-photo.jpg",
  };
}

export async function addSketch(file: File, token: string) {
  const db = storage();
  const find = () =>
    db.prepare("SELECT id FROM sketch_jobs WHERE upload_token = ?").get(token);
  const previous = find();
  if (previous) return getSketch(String(previous.id));
  const photo = await prepareSketchPhoto(file);
  const id = randomUUID();
  const at = new Date().toISOString();
  const draft: SketchDraft = {
    title:
      photo.fileName
        .replace(/\.[^.]+$/, "")
        .trim()
        .slice(0, 120) || "New sketch",
    units: null,
    parts: [blankPart()],
  };
  db.prepare(
    `INSERT INTO sketch_jobs
    (id, upload_token, file_name, mime_type, original, preview, version, draft, findings, questions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, '[]', '[]', ?, ?) ON CONFLICT(upload_token) DO NOTHING`,
  ).run(
    id,
    token,
    photo.fileName,
    photo.mimeType,
    photo.original,
    photo.preview,
    JSON.stringify(draft),
    at,
    at,
  );
  return getSketch(String(find()!.id));
}

function requireVersion(id: string, version: number) {
  const sketch = getSketch(id);
  if (sketch.version !== version) {
    throw new QuoteError(
      "This sketch has newer changes. Reopen it before continuing.",
      409,
    );
  }
  return sketch;
}

export async function saveSketch(
  id: string,
  version: number,
  value: unknown,
  confirm = false,
) {
  const draft = parseSketchDraft(value);
  const issues = confirm ? drawingIssues(draft) : [];
  if (issues.length) throw new QuoteError(issues[0], 422);
  const existing = requireVersion(id, version);
  if (existing.confirmed && JSON.stringify(existing.draft) === JSON.stringify(draft)) return existing;
  // Compile outside the write transaction. Recheck the version after the worker finishes.
  const bundle = confirm ? await compileShopFiles(draft, version + 1) : null;
  const db = storage();
  return write(() => {
    const current = requireVersion(id, version);
    const content = JSON.stringify(draft);
    if (
      content === JSON.stringify(current.draft) &&
      (!confirm || current.confirmed)
    )
      return current;
    const next = version + 1;
    const at = new Date().toISOString();
    db.prepare(
      "UPDATE sketch_jobs SET version = ?, draft = ?, updated_at = ? WHERE id = ?",
    ).run(next, content, at, id);
    if (confirm)
      db.prepare("INSERT INTO sketch_revisions VALUES (?, ?, ?, ?, NULL)").run(
        id,
        next,
        content,
        at,
      );
    if (bundle) db.prepare("INSERT INTO sketch_compilations VALUES (?,?,?)")
      .run(id, next, Buffer.from(JSON.stringify(bundle)));
    return getSketch(id);
  });
}

const pendingReads = new Map<string, Promise<SketchJob>>();

export function extractSketch(id: string, version: number): Promise<SketchJob> {
  requireVersion(id, version);
  const pendingKey = id + "/" + version;
  const pending = pendingReads.get(pendingKey);
  if (pending) return pending;
  const request = (async () => {
    const result = await readSketch(getSketchPhoto(id));
    const at = new Date().toISOString();
    const updated = storage()
      .prepare(
        `UPDATE sketch_jobs SET
      version = version + 1, draft = ?, findings = ?, questions = ?, read_at = ?, provider = ?, model = ?,
      raw_result = ?, updated_at = ? WHERE id = ? AND version = ?`,
      )
      .run(
        JSON.stringify(result.reading.draft),
        JSON.stringify(result.reading.findings),
        JSON.stringify(result.reading.questions),
        at,
        result.provider,
        result.model,
        result.raw,
        at,
        id,
        version,
      );
    if (!updated.changes)
      throw new QuoteError(
        "Your edits were saved while the photo was being read. Reopen the sketch to see them.",
        409,
      );
    return getSketch(id);
  })().finally(() => pendingReads.delete(pendingKey));
  pendingReads.set(pendingKey, request);
  return request;
}

export function getConfirmedSketch(id: string, version: number) {
  const row = storage()
    .prepare(
      "SELECT draft FROM sketch_revisions WHERE sketch_id = ? AND version = ?",
    )
    .get(id, version);
  if (!row)
    throw new QuoteError("Confirm this drawing before using its files.", 409);
  return JSON.parse(String(row.draft)) as SketchDraft;
}

export async function confirmedFiles(id: string, version: number): Promise<ShopFiles> {
  const draft = getConfirmedSketch(id, version);
  const db = storage();
  const read = () => db.prepare("SELECT bundle FROM sketch_compilations WHERE sketch_id=? AND version=?").get(id, version);
  let row = read();
  if (!row) {
    // Archives created before the Python compiler have only their frozen input drawing.
    const bundle = await compileShopFiles(draft, version);
    db.prepare("INSERT OR IGNORE INTO sketch_compilations VALUES (?,?,?)").run(id, version, Buffer.from(JSON.stringify(bundle)));
    row = read();
  }
  return JSON.parse(Buffer.from(row!.bundle as Uint8Array).toString("utf8"));
}

function reviewPart(
  part: SketchPart,
  units: string,
  sheet: number,
  version: number,
): ReviewPart {
  const bounds = partBounds(part)!;
  const round = part.holes.filter((hole) => hole.shape === "round").length;
  const slots = part.holes.length - round;
  const requirements = [
    ...(round ? [round + (round === 1 ? " hole" : " holes")] : []),
    ...(slots ? [slots + (slots === 1 ? " slot" : " slots")] : []),
    ...(part.bendLines ?? []).map((bend, i) => (bend.label || ("Bend " + (i + 1))) + " from (" + bend.start.x + ", " + bend.start.y + ") to (" + bend.end.x + ", " + bend.end.y + ") " + units),
    part.notes,
  ]
    .filter(Boolean)
    .join(". ");
  const values: Partial<Record<FieldKey, string>> = {
    description: part.name,
    material: part.material,
    thickness: `${part.thickness} ${units}`,
    dimensions: `${bounds.width} x ${bounds.height}`,
    units,
    quantity: String(part.quantity),
    revision: String(version),
    requirements,
  };
  return {
    fields: Object.fromEntries(
      fieldKeys.map((key) => {
        const value = values[key] ?? "";
        const onMainSheet = key !== "requirements" && key !== "revision";
        return [
          key,
          {
            value,
            status: value ? "found" : "missing",
            evidence:
              value && onMainSheet ? [{ page: sheet, excerpt: value }] : [],
          },
        ];
      }),
    ) as ReviewPart["fields"],
  };
}

function quoteFromShopSheet(id:string,version:number,draft:SketchDraft,photo:{bytes:Buffer;fileName:string},pdf:Buffer,partPages:number[]) {
  const quote = createQuote({
    ...newQuoteDraft(getEstimatingSettings().defaultMargin),
    customer: drawingDraftCustomer,
    jobName: draft.title,
    notes: "",
    items: draft.parts.map((part) => ({
      id: randomUUID(),
      description: part.name,
      quantity: part.quantity,
      costRows: [],
    })),
  });
  try {
    uploadDrawing(quote.id, photo, "", "Source photo");
    const drawing = uploadDrawing(
      quote.id,
      { bytes: pdf, fileName: "Shop-drawing-v" + version + ".pdf" },
      "",
      String(version),
    );
    applyConfirmedShopDrawing(
      quote.id,
      drawing.selectedRevisionId!,
      draft.parts.map((part, index) => ({
        itemId: quote.items[index].id,
        part: reviewPart(part, draft.units!, partPages[index], version),
      })),
      { sketchId: id, sketchVersion: version },
    );
  } catch (error) {
    if (error instanceof DrawingError)
      throw new QuoteError(error.message, error.status);
    throw error;
  }
  return quote;
}

export function quoteFromSketchRelease(id:string,version:number,draft:SketchDraft, photo:{bytes:Buffer;fileName:string}, pdf:Buffer,partPages:number[]){
  const db=storage();
  return write(()=>{
    const existing=db.prepare("SELECT quote_id FROM photo_release_quotes WHERE source_id=? AND revision=?").get(id,version);
    if(existing)return String(existing.quote_id);
    const quote=quoteFromShopSheet(id,version,draft,photo,pdf,partPages);
    db.prepare("INSERT INTO photo_release_quotes VALUES(?,?,?)").run(id,version,quote.id);
    return quote.id;
  });
}

export async function linkSketchQuote(id: string, version: number) {
  const initial = requireVersion(id, version);
  if (initial.linkedQuoteId) return initial;
  const draft = getConfirmedSketch(id, version);
  const photo = getSketchPhoto(id);
  const { pdf: encoded, partPages } = await confirmedFiles(id, version);
  const pdf = Buffer.from(encoded, "base64");
  const db = storage();
  return write(() => {
    const current = requireVersion(id, version);
    if (current.linkedQuoteId) return current;
    const quote = quoteFromShopSheet(id, version, draft, photo, pdf, partPages);
    db.prepare(
      "UPDATE sketch_revisions SET quote_id = ? WHERE sketch_id = ? AND version = ?",
    ).run(quote.id, id, version);
    return getSketch(id);
  });
}
