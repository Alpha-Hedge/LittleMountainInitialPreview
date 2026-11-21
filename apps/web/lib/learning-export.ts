import { createHash } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { getDb } from "./db";
import { learningSources, type LearningSource } from "./learning-tables";
import { initializeLearningTracking } from "./learning-tracking";
import { listLocalLearningCandidates } from "./comparables";
import { calculateQuote } from "./quotes";
import { fieldKeys, type PartCorrection, type ReviewPart } from "./review-types";
import { decodeSavedRateBook } from "./estimating";
import type { Comparable } from "./job-types";
import { exportEngineeringLearning } from "./engineering-learning";

export interface LearningRecord {
  kind: string;
  key: string;
  data: Record<string, unknown>;
}
export interface LearningFile {
  sha256: string;
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface LearningEntity {
  key: string;
  generation: number;
  records: LearningRecord[];
  files: LearningFile[];
  candidates: Comparable[];
}
type Row = Record<string, SQLOutputValue>;

function trackedDb() {
  const db = getDb();
  initializeLearningTracking(db);
  return db;
}

export function getLearningWorkspaceId(): string {
  return String(
    trackedDb().prepare("SELECT value FROM app_meta WHERE name='learning_workspace'").get()!.value,
  );
}

export function getPendingLearningEntities(limit = 50): { key: string; generation: number }[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid learning sync batch size.");
  return trackedDb()
    .prepare(
      `SELECT entity_key,generation FROM learning_queue WHERE generation>acknowledged
    ORDER BY generation,entity_key LIMIT ?`,
    )
    .all(limit)
    .map((r) => ({ key: String(r.entity_key), generation: Number(r.generation) }));
}

export function getLearningSyncCounts(): { total: number; pending: number } {
  const counts = trackedDb()
    .prepare(
      `SELECT count(*) AS total, count(*) FILTER (WHERE generation>acknowledged) AS pending
    FROM learning_queue`,
    )
    .get()!;
  return { total: Number(counts.total), pending: Number(counts.pending) };
}

export function acknowledgeLearningEntity(key: string, generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new Error("Invalid learning generation.");
  // A slow upload of generation N must leave any edits to generation N+1 pending.
  trackedDb()
    .prepare(
      `UPDATE learning_queue SET acknowledged=?
    WHERE entity_key=? AND acknowledged<? AND generation>=?`,
    )
    .run(generation, key, generation, generation);
}

export function requestLearningBackfill() {
  trackedDb().exec(
    `UPDATE learning_queue SET generation=MAX(generation+1,CAST(unixepoch('subsec')*1000 AS INTEGER))`,
  );
}

function sourceRows(db: DatabaseSync, source: LearningSource, id: string) {
  const { owner } = source;
  const select = "SELECT " + source.columns + " FROM " + source.table;
  if (!owner) return db.prepare(select).iterate();
  const where =
    typeof owner === "string"
      ? owner + " = ?"
      : owner.column + " IN (SELECT id FROM " + owner.parent + " WHERE quote_id = ?)";
  return db.prepare(select + " WHERE " + where).iterate(id);
}

function fileDetails(kind: string, column: string, row: Row) {
  if (column === "thumbnail") return { fileName: "preview.png", mimeType: "image/png" };
  if (column === "customer_pdf")
    return { fileName: "quote-v" + row.version + ".pdf", mimeType: "application/pdf" };
  if (kind === "request_message" || kind === "delivery")
    return { fileName: String(row.id) + ".eml", mimeType: "message/rfc822" };
  return { fileName: String(row.file_name ?? row.name), mimeType: String(row.mime) };
}

function encodeRow(source: LearningSource, row: Row, files: Map<string, LearningFile>): LearningRecord {
  const data: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      const sha256 = createHash("sha256").update(value).digest("hex");
      const details = fileDetails(source.kind, column, row);
      if (!files.has(sha256))
        files.set(sha256, {
          sha256,
          bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength),
          ...details,
        });
      data[column] = { sha256, size: value.byteLength, ...details };
    } else if (value !== null && source.json?.includes(column)) {
      data[column] = JSON.parse(String(value));
    } else data[column] = value;
  }
  // Composite primary keys use JSON so user-supplied separators cannot create collisions.
  const key =
    source.key.length === 1
      ? String(row[source.key[0]])
      : JSON.stringify(source.key.map((col) => row[col]));
  return { kind: source.kind, key, data };
}

function datedRules(record: LearningRecord, row: Row): LearningRecord[] {
  const settings = decodeSavedRateBook(row);
  const saved = {
    settings_version: settings.version,
    recorded_at: record.data.created_at,
    demo: settings.demo,
  };
  return [
    ...settings.rates.map((rate) => ({
      kind: "shop_rate",
      key: JSON.stringify([settings.version, rate.id]),
      data: { ...saved, ...rate },
    })),
    ...settings.templates.map((template) => ({
      kind: "estimating_template",
      key: JSON.stringify([settings.version, template.id]),
      data: { ...saved, ...template },
    })),
  ];
}

function confirmedSpecs(records: LearningRecord[]): LearningRecord[] {
  const runs = new Map(records.filter((r) => r.kind === "review_run").map((r) => [r.key, r.data]));
  const applied = new Map(
    records
      .filter((r) => r.kind === "review_edit" && r.data.action === "apply")
      .map((r) => [r.data.run_id, r.data]),
  );
  return records
    .filter((r) => r.kind === "applied_specification")
    .map(({ key, data }) => {
      const run = runs.get(String(data.run_id)),
        edit = applied.get(data.run_id);
      if (!run || !edit) throw new Error("Incomplete source review for confirmed specifications.");
      const index = Number(data.part_index);
      const part = (run.parts as ReviewPart[])[index],
        corrected = (edit.corrections as PartCorrection[])[index];
      const fields = Object.fromEntries(
        fieldKeys.map((name) => {
          const extracted = part.fields[name];
          const wasEdited = Object.hasOwn(corrected.values, name);
          return [
            name,
            {
              value: wasEdited
                ? corrected.values[name]
                : extracted.status === "found"
                  ? extracted.value
                  : "",
              corrected: wasEdited,
              extractedStatus: extracted.status,
              evidence: extracted.evidence,
            },
          ];
        }),
      );
      return {
        kind: "confirmed_specification",
        key,
        data: {
          run_id: data.run_id,
          item_id: data.item_id,
          part_index: index,
          revision_id: run.revision_id,
          source_quote_version: run.quote_version,
          review_edit: edit.version,
          confirmed_at: edit.created_at,
          fields,
        },
      };
    });
}

export function exportLearningEntity(key: string): LearningEntity {
  const db = trackedDb();
  if (key !== "shop" && !key.startsWith("quote:") && !key.startsWith("engineering:")) throw new Error("Unrecognized learning entity.");
  const id = key.slice("quote:".length);
  // Read a single committed SQLite snapshot. Network I/O starts only after this transaction closes.
  db.exec("SAVEPOINT export_learning_entity");
  try {
    const queued = db.prepare("SELECT generation FROM learning_queue WHERE entity_key=?").get(key);
    if (!queued) throw new Error("Learning entity does not exist.");
    if (key.startsWith("engineering:")) {
      const snapshot = exportEngineeringLearning(key, Number(queued.generation));
      db.exec("RELEASE export_learning_entity");
      return snapshot;
    }
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((r) => String(r.name)),
    );
    const files = new Map<string, LearningFile>(),
      records: LearningRecord[] = [];
    for (const source of learningSources) {
      if (!tables.has(source.table) || (key === "shop") !== (source.owner === null)) continue;
      for (const row of sourceRows(db, source, id)) {
        const record = encodeRow(source, row, files);
        if (record.kind === "quote" || record.kind === "quote_version")
          record.data.totals = calculateQuote(record.data.draft);
        records.push(record);
        if (record.kind === "estimating_settings") records.push(...datedRules(record, row));
      }
    }
    records.push(...confirmedSpecs(records));
    const quote = records.find((r) => r.kind === "quote");
    const isDemo =
      id === "demo-mounting-plate" ||
      records.some(
        (r) =>
          r.kind === "request_message" &&
          ["<fp108-A@ridgeline.example>", "<fp108-B@ridgeline.example>"].includes(String(r.data.rfc_id)),
      );
    let candidates: Comparable[] = [];
    if (quote) {
      quote.data.is_demo = isDemo;
      const versions = records.filter((r) => r.kind === "quote_version");
      quote.data.first_available_version = versions.length
        ? Math.min(...versions.map((v) => Number(v.data.version)))
        : quote.data.version;
      if (!isDemo && records.some((r) => r.kind === "workflow_version" && r.data.approved_at))
        candidates = listLocalLearningCandidates(id);
    }
    db.exec("RELEASE export_learning_entity");
    return {
      key,
      generation: Number(queued.generation),
      records,
      files: [...files.values()],
      candidates,
    };
  } catch (error) {
    db.exec("ROLLBACK TO export_learning_entity; RELEASE export_learning_entity");
    throw error;
  }
}
