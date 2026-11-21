import { parse } from "csv-parse/sync";
import { getDb } from "./db";
import { getApprovalSnapshot } from "./workflow";
import { QuoteError } from "./quotes";
import { actualCosts } from "./actual-costs";
import { actualKinds, isTime, type ActualRow, type JobRecord } from "./job-types";
import type { Quote } from "./types";

function jobsDb() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS completed_job_edits (
    quote_id TEXT NOT NULL REFERENCES quotes(id), quote_version INTEGER NOT NULL, edit INTEGER NOT NULL,
    payload TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (quote_id,quote_version,edit)
  )`);
  return db;
}
export function getJob(id: string, version: number, edit?: number): JobRecord | null {
  const db = jobsDb();
  const row =
    edit === undefined
      ? db
          .prepare(
            "SELECT payload FROM completed_job_edits WHERE quote_id=? AND quote_version=? ORDER BY edit DESC LIMIT 1",
          )
          .get(id, version)
      : db
          .prepare(
            "SELECT payload FROM completed_job_edits WHERE quote_id=? AND quote_version=? AND edit=?",
          )
          .get(id, version, edit);
  return row ? JSON.parse(String(row.payload)) : null;
}
function note(value: unknown, name: string, required = false) {
  if (typeof value !== "string" || value.length > 8000 || (required && !value.trim()))
    throw new QuoteError("Enter a valid " + name + ".");
  return value.trim();
}
function validNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
}
function checkedRow(value: unknown, quote: Quote): ActualRow {
  if (!value || typeof value !== "object") throw new QuoteError("Invalid actual cost row.");
  const row = value as ActualRow;
  if (!quote.items.some((i) => i.id === row.itemId))
    throw new QuoteError("Select an approved line for every actual.");
  if (!actualKinds.includes(row.kind)) throw new QuoteError("Select a valid cost category.");
  if (
    !validNumber(row.amount) ||
    (!validNumber(row.unitCost) && !(isTime(row.kind) && row.unitCost === null))
  ) {
    throw new QuoteError(
      "Actual quantities and costs must be nonnegative. Material and outside costs need a unit cost.",
    );
  }
  if (isTime(row.kind) && !/^(?:h|hr|hrs|hour|hours)$/i.test(row.unit))
    throw new QuoteError("Use hours for setup, labor and machine entries.");
  return {
    itemId: row.itemId,
    kind: row.kind,
    operation: note(row.operation, "operation or material name", true),
    amount: row.amount,
    unit: isTime(row.kind) ? "h" : note(row.unit, "unit", true),
    unitCost: row.unitCost,
    ...(row.exceptionReason
      ? { exceptionReason: note(row.exceptionReason, "one-time exception reason", true) }
      : {}),
  };
}
export function parseActualsCsv(csv: string, quote: Quote): ActualRow[] {
  if (typeof csv !== "string" || csv.length > 1_000_000)
    throw new QuoteError("Use a CSV file under 1 MB.");
  const columns = ["line", "category", "operation", "amount", "unit", "unit_cost"];
  let entries: Record<string, string>[];
  try {
    entries = parse(csv, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      columns: (headers: string[]) => {
        const permitted = [...columns, "exception_reason"];
        if (
          new Set(headers).size !== headers.length ||
          headers.some((h) => !permitted.includes(h)) ||
          !columns.every((c) => headers.includes(c))
        )
          throw new Error("headers");
        return headers;
      },
    });
  } catch {
    throw new QuoteError("Check CSV quoting and the headers: " + columns.join(", ") + ".");
  }
  if (!entries.length || entries.length > 500)
    throw new QuoteError("Import between 1 and 500 actual rows.");
  return entries.map((r, index) => {
    try {
      if (!/^\d+$/.test(r.line) || !r.amount.trim())
        throw new QuoteError("Supply a line number and amount.");
      return checkedRow(
        {
          itemId: quote.items[Number(r.line) - 1]?.id,
          kind: r.category,
          operation: r.operation,
          amount: Number(r.amount),
          unit: r.unit,
          unitCost: r.unit_cost === "" ? null : Number(r.unit_cost),
          exceptionReason: r.exception_reason?.trim(),
        },
        quote,
      );
    } catch (e) {
      throw new QuoteError(
        "CSV row " + (index + 2) + ". " + (e instanceof Error ? e.message : "Invalid data."),
      );
    }
  });
}
export function saveJob(id: string, version: number, body: JobRecord): JobRecord {
  const approval = getApprovalSnapshot(id, version);
  if (!approval) throw new QuoteError("Choose an approved quote version.", 404);
  if (!body || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 500)
    throw new QuoteError("Record between 1 and 500 actual rows.");
  if (!Number.isSafeInteger(body.edit) || body.edit < 0)
    throw new QuoteError("Supply the record's saved edit number.");
  if (
    !/^\d{4}-\d\d-\d\d$/.test(body.completedOn) ||
    !Number.isFinite(Date.parse(body.completedOn)) ||
    new Date(body.completedOn).toISOString().slice(0, 10) !== body.completedOn
  )
    throw new QuoteError("Choose a valid completion date.");
  const job: JobRecord = {
    quoteId: id,
    version,
    edit: body.edit + 1,
    completedOn: body.completedOn,
    rows: body.rows.map((r) => checkedRow(r, approval.quote)),
    scopeChanges: note(body.scopeChanges, "scope change"),
    overrideReasons: note(body.overrideReasons, "exception or override reason"),
  };
  const insert = jobsDb()
    .prepare(`INSERT INTO completed_job_edits (quote_id,quote_version,edit,payload,recorded_at)
    SELECT ?,?,?,?,? WHERE ?=(SELECT COALESCE(MAX(edit),0) FROM completed_job_edits WHERE quote_id=? AND quote_version=?)`);
  const costs = actualCosts(job.rows.map(r => [r.amount, r.unitCost]));
  job.rows.forEach((r, i) => { r.extendedCost = costs.rows[i]; });
  if (
    !insert.run(
      id,
      version,
      job.edit,
      JSON.stringify(job),
      new Date().toISOString(),
      body.edit,
      id,
      version,
    ).changes
  ) {
    throw new QuoteError("Job actuals changed in another window. Reopen the record before saving.", 409);
  }
  return job;
}
