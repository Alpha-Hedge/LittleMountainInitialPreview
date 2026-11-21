import { workspaceRoot } from "./workspace-root";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { getDb } from "./db";
import { getQuote } from "./quotes";
import { maxDrawingBytes, type DrawingMime, type DrawingRevision, type DrawingState } from "./drawing-types";

export class DrawingError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

const demoQuoteId = "demo-mounting-plate";
const records = `
  SELECT r.id, a.id AS attachmentId, a.name AS attachmentName, r.label,
         r.file_name AS fileName, r.mime AS mimeType, length(r.original) AS size,
         r.created_at AS createdAt, r.thumbnail IS NOT NULL AS hasThumbnail
  FROM drawing_revisions r JOIN drawing_attachments a ON r.attachment_id = a.id
`;
const schemaReady = new WeakSet<DatabaseSync>();

function transaction<T>(db: DatabaseSync, operation: () => T) {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT lmm_drawing" : "BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec(nested ? "RELEASE lmm_drawing" : "COMMIT");
    return result;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO lmm_drawing; RELEASE lmm_drawing" : "ROLLBACK");
    throw error;
  }
}

function select(db: DatabaseSync, quoteId: string, revisionId: string) {
  db.prepare(`INSERT INTO drawing_selections (quote_id, revision_id) VALUES (?, ?)
    ON CONFLICT (quote_id) DO UPDATE SET revision_id = excluded.revision_id`).run(quoteId, revisionId);
}

function storage(quoteId: string) {
  if (!getQuote(quoteId)) throw new DrawingError("Quote not found.", 404);
  const db = getDb();
  if (!schemaReady.has(db)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS drawing_attachments (
        id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drawing_attachments_by_quote ON drawing_attachments(quote_id);
      CREATE TABLE IF NOT EXISTS drawing_revisions (
        id TEXT PRIMARY KEY, attachment_id TEXT NOT NULL REFERENCES drawing_attachments(id),
        label TEXT NOT NULL COLLATE NOCASE, file_name TEXT NOT NULL, mime TEXT NOT NULL,
        original BLOB NOT NULL, thumbnail BLOB, created_at TEXT NOT NULL, UNIQUE(attachment_id, label)
      );
      CREATE TABLE IF NOT EXISTS drawing_selections (
        quote_id TEXT PRIMARY KEY REFERENCES quotes(id), revision_id TEXT NOT NULL REFERENCES drawing_revisions(id)
      );
    `);
    if (!db.isTransaction) schemaReady.add(db);
  }
  if (quoteId === demoQuoteId && !db.prepare("SELECT 1 FROM app_meta WHERE name = 'demo_drawing_v1'").get()) {
    transaction(db, () => {
      const claim = db.prepare("INSERT OR IGNORE INTO app_meta VALUES ('demo_drawing_v1', '1')").run();
      if (!claim.changes) return;
      const dir = path.join(workspaceRoot(), "fixtures", "drawings");
      const bytes = readFileSync(path.join(dir, "mounting-plate-assembly.pdf"));
      const thumbnail = readFileSync(path.join(dir, "mounting-plate-preview.png"));
      const attachmentId = randomUUID();
      const revisionId = randomUUID();
      db.prepare("INSERT INTO drawing_attachments VALUES (?, ?, ?)").run(attachmentId, quoteId, "Mounting plate assembly");
      db.prepare(`INSERT INTO drawing_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        revisionId, attachmentId, "B", "RF-2417_Mounting-plate.pdf", "application/pdf", bytes,
        thumbnail, new Date().toISOString(),
      );
      select(db, quoteId, revisionId);
    });
  }
  return db;
}

type RecordRow = Record<string, SQLOutputValue>;
function revision(row: RecordRow): DrawingRevision {
  return {
    id: String(row.id), attachmentId: String(row.attachmentId), label: String(row.label),
    fileName: String(row.fileName), mimeType: row.mimeType as DrawingMime, size: Number(row.size),
    createdAt: String(row.createdAt), hasThumbnail: Boolean(row.hasThumbnail),
  };
}

export function getDrawingState(quoteId: string): DrawingState {
  const db = storage(quoteId);
  const attachments = new Map<string, DrawingState["attachments"][number]>();
  const rows = db.prepare(`${records} WHERE a.quote_id = ? ORDER BY a.rowid, r.rowid DESC`).all(quoteId);
  for (const row of rows) {
    const result = revision(row);
    const group = attachments.get(result.attachmentId) ?? {
      id: result.attachmentId, name: String(row.attachmentName), revisions: [],
    };
    group.revisions.push(result);
    attachments.set(group.id, group);
  }
  const selected = db.prepare("SELECT revision_id FROM drawing_selections WHERE quote_id = ?").get(quoteId);
  return { attachments: [...attachments.values()], selectedRevisionId: selected ? String(selected.revision_id) : null };
}

export function getDrawingRevision(quoteId: string, revisionId: string) {
  const db = storage(quoteId);
  const meta = db.prepare(`${records} WHERE a.quote_id = ? AND r.id = ?`).get(quoteId, revisionId);
  if (!meta) return null;
  const file = db.prepare("SELECT original FROM drawing_revisions WHERE id = ?").get(revisionId)!;
  return { ...revision(meta), bytes: Buffer.from(file.original as Uint8Array) };
}

export async function getDrawingPage(quoteId: string, revisionId: string, page: number) {
  if (!Number.isSafeInteger(page) || page < 1) throw new DrawingError("Enter a positive page number.");
  const file = getDrawingRevision(quoteId, revisionId);
  if (!file) throw new DrawingError("Revision not found on this quote.", 404);
  if (file.mimeType !== "application/pdf") {
    if (page !== 1) throw new DrawingError("Page not found.", 404);
    return { bytes: file.bytes, mime: file.mimeType, count: 1 };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "lmm-preview-"));
  try {
    const input = path.join(dir, "original.pdf");
    await writeFile(input, file.bytes);
    await promisify(execFile)(process.execPath, [
      path.join(workspaceRoot(), "scripts", "render-source.mjs"), input, file.mimeType, dir, "preview", String(page),
    ], { timeout: 30000, windowsHide: true });
    const count = Number(await readFile(path.join(dir, "page-count"), "utf8"));
    if (page > count) throw new DrawingError("Page not found.", 404);
    return { bytes: await readFile(path.join(dir, "thumbnail.png")), mime: "image/png", count };
  } catch (error) {
    if (error instanceof DrawingError) throw error;
    throw new DrawingError("Preview unavailable. Open the original file.", 422);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function getDrawingThumbnail(quoteId: string, revisionId: string) {
  const db = storage(quoteId);
  const row = db.prepare(`SELECT thumbnail, mime FROM drawing_revisions r
    JOIN drawing_attachments a ON a.id = r.attachment_id WHERE a.quote_id = ? AND r.id = ?`).get(quoteId, revisionId);
  if (!row || row.mime !== "application/pdf") return null;
  if (row.thumbnail) return Buffer.from(row.thumbnail as Uint8Array);
  const first = await getDrawingPage(quoteId, revisionId, 1);
  db.prepare("UPDATE drawing_revisions SET thumbnail = ? WHERE id = ? AND thumbnail IS NULL").run(first.bytes, revisionId);
  return first.bytes;
}

function detectMime(bytes: Buffer): DrawingMime {
  if (bytes.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw new DrawingError("Choose a PDF, PNG, JPEG, or WebP file.", 415);
}

export function uploadDrawing(quoteId: string, file: { bytes: Buffer; fileName: string }, attachmentId: string, label: string) {
  if (!file.bytes.length || file.bytes.length > maxDrawingBytes) throw new DrawingError("Choose a file between 1 byte and 20 MB.", 413);
  const mime = detectMime(file.bytes);
  const name = file.fileName.split(/[\\/]/).at(-1)?.trim();
  if (!name || name.length > 240 || /[\u0000-\u001f\u007f]/u.test(name)) throw new DrawingError("Choose a file with a valid filename.");
  const cleanLabel = label.trim();
  if (cleanLabel.length > 60) throw new DrawingError("Use a revision label of 60 characters or less.");
  const db = storage(quoteId);
  transaction(db, () => {
    let group = attachmentId;
    if (group) {
      if (!db.prepare("SELECT 1 FROM drawing_attachments WHERE id = ? AND quote_id = ?").get(group, quoteId)) {
        throw new DrawingError("Drawing not found on this quote.", 404);
      }
    } else {
      group = randomUUID();
      db.prepare("INSERT INTO drawing_attachments VALUES (?, ?, ?)").run(group, quoteId, name);
    }
    const existing = db.prepare("SELECT label FROM drawing_revisions WHERE attachment_id = ?").all(group);
    const labels = new Set(existing.map((row) => String(row.label).toLowerCase()));
    let ordinal = labels.size + 1;
    while (labels.has(String(ordinal))) ordinal++;
    const newLabel = cleanLabel || String(ordinal);
    if (labels.has(newLabel.toLowerCase())) throw new DrawingError("That revision label already exists for this drawing.", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO drawing_revisions VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").run(
      id, group, newLabel, name, mime, file.bytes, new Date().toISOString(),
    );
    select(db, quoteId, id);
  });
  return getDrawingState(quoteId);
}

export function selectDrawingRevision(quoteId: string, revisionId: string) {
  const db = storage(quoteId);
  if (!db.prepare(`SELECT 1 FROM drawing_revisions r JOIN drawing_attachments a ON r.attachment_id = a.id
    WHERE r.id = ? AND a.quote_id = ?`).get(revisionId, quoteId)) throw new DrawingError("Revision not found on this quote.", 404);
  select(db, quoteId, revisionId);
  return getDrawingState(quoteId);
}
