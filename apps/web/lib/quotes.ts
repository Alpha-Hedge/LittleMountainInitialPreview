import { createHash } from "node:crypto";
import { runPricing, EngineeringInputError } from "./python-engine";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { changedEstimateInputs,isStockMaterial } from "./types";
import type { CostRow, LineItem, Quote, QuoteDraft, QuoteTotals, RowEstimate } from "./types";

export class QuoteError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QuoteError(`Invalid ${name}.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, limit: number, required = true): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) {
    throw new QuoteError(`Enter a valid ${field} (up to ${limit} characters).`);
  }
  return value;
}

function decimal(value: unknown, field: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    !/^\d+(?:\.\d{1,4})?$/.test(String(value))
  ) {
    throw new QuoteError(`${field} must be between 0 and ${max}, with up to four decimal places.`);
  }
  return value;
}

function checkIds(entries: { id: string }[], kind: string) {
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new QuoteError(`Each ${kind} needs a unique ID.`);
  }
}

function readEstimate(input: unknown): RowEstimate {
  const value = object(input, "estimate basis");
  const category = value.category as RowEstimate["category"];
  const driver = value.driver as RowEstimate["driver"];
  if (!["material", "setup", "labor", "machine", "outside"].includes(category) ||
      !["fixed", "holes", "area_m2", "length_m"].includes(driver) || typeof value.demo !== "boolean" ||
      !Number.isSafeInteger(value.settingsVersion) || Number(value.settingsVersion) < 1) {
    throw new QuoteError("Invalid estimating rule or rate book version.");
  }
  return {
    category, driver, demo: value.demo, settingsVersion: Number(value.settingsVersion),
    ...(value.rateSource === undefined ? {} : {rateSource:string(value.rateSource,"rate source",500),
      rateEffectiveOn:string(value.rateEffectiveOn,"rate effective date",10),
      rateSettingsVersion:decimal(value.rateSettingsVersion,"Rate revision",1_000_000_000)}),
    unit: string(value.unit, "rate unit", 100), includes: string(value.includes, "rate coverage", 3000),
    rateId: string(value.rateId, "rate ID", 128), templateId: string(value.templateId, "template ID", 128),
    templateName: string(value.templateName, "template name", 500), operationId: string(value.operationId, "operation ID", 128),
    workType: string(value.workType, "work type", 500), rationale: string(value.rationale, "estimate basis", 8000),
    assumption: string(value.assumption, "assumption", 8000, false),
    overrideReason: string(value.overrideReason, "override reason", 8000, false),
    minimumCost: decimal(value.minimumCost, "Minimum charge", 1_000_000_000),
    baselineAmount: decimal(value.baselineAmount, "Suggested amount", 1_000_000_000),
    baselineRate: decimal(value.baselineRate, "Suggested rate", 1_000_000_000),
    coefficient: decimal(value.coefficient, "Operation coefficient", 1_000_000_000),
    reviewedRevisionId: value.reviewedRevisionId == null ? null : string(value.reviewedRevisionId, "revision ID", 128),
    reviewRunId: value.reviewRunId == null ? null : string(value.reviewRunId, "review ID", 128),
  };
}

function readRow(value: unknown, requireText: boolean): CostRow {
  const row = object(value, "cost row");
  if (row.basis !== "per_unit" && row.basis !== "batch") {
    throw new QuoteError("Choose per unit or once per batch for every cost row.");
  }
  let review:CostRow["review"];
  if(row.review!=null){
    const v=object(row.review,"work-center override");
    if(v.disposition!=="standard" && v.disposition!=="one_time")throw new QuoteError("Select the type of override.");
    review={reason:string(v.reason,"override reason",2000,requireText),disposition:v.disposition,
      ...(v.unitCost==null?{}:{unitCost:decimal(v.unitCost,"Override cost",1_000_000_000)})};
  }
  if(row.bufferMaterial!==undefined && typeof row.bufferMaterial!=="boolean")throw new QuoteError("Choose the material rows for the scrap buffer.");
  return {
    id: string(row.id, "cost row ID", 128),
    label: string(row.label, "cost label", 500, requireText),
    amount: decimal(row.amount, "Amount", 1_000_000_000),
    rate: decimal(row.rate, "Rate", 1_000_000_000),
    basis: row.basis,
    ...(review?{review}:{}),...(row.bufferMaterial===undefined?{}:{bufferMaterial:row.bufferMaterial}),
    ...(row.estimate == null ? {} : { estimate: readEstimate(row.estimate) }),
  };
}

function readItem(value: unknown, requireText: boolean): LineItem {
  const item = object(value, "line item");
  if (typeof item.quantity !== "number" || !Number.isInteger(item.quantity) ||
      item.quantity < 1 || item.quantity > 1_000_000_000) {
    throw new QuoteError("Quantity must be a whole number between 1 and 1000000000.");
  }
  if (!Array.isArray(item.costRows) || item.costRows.length > 500) {
    throw new QuoteError("A line item can contain up to 500 cost rows.");
  }
  const costRows = item.costRows.map((row) => readRow(row, requireText));
  checkIds(costRows, "cost row in a line item");
  return {
    id: string(item.id, "line item ID", 128),
    description: string(item.description, "line item description", 16000, requireText),
    quantity: item.quantity,
    ...(item.quantityPending === true ? { quantityPending: true } : {}),
    costRows,
  };
}

function readDraft(value: unknown, requireText: boolean): QuoteDraft {
  const draft = object(value, "quote");
  if (!Array.isArray(draft.items) || draft.items.length === 0 || draft.items.length > 500) {
    throw new QuoteError("A quote needs between 1 and 500 line items.");
  }
  const items = draft.items.map((item) => readItem(item, requireText));
  checkIds(items, "line item");
  const benchmark = draft.benchmark === undefined ? null : object(draft.benchmark, "benchmark details");
  const takeoff = benchmark?.takeoff === undefined ? null : object(benchmark.takeoff,"drawing budget");
  if (takeoff && takeoff.scope !== "shop" && takeoff.scope !== "installed") throw new QuoteError("Choose a drawing budget scope.");
  if (benchmark && (!Array.isArray(benchmark.unpriced) || benchmark.unpriced.length > 250))
    throw new QuoteError("Invalid benchmark open cost list.");
  return {
    ...(benchmark ? { benchmark: {
      name: string(benchmark.name, "benchmark name", 100),
      date: string(benchmark.date, "benchmark date", 10),
      ...(typeof benchmark.demo === "boolean" ? {demo:benchmark.demo} : {}),
      ...(takeoff ? {takeoff:{
        id:string(takeoff.id,"takeoff ID",128), revisionId:string(takeoff.revisionId,"takeoff drawing revision",128),
        scope:takeoff.scope as "shop" | "installed",
        contingencyPercent:decimal(takeoff.contingencyPercent,"Budget contingency percent",100),
        ...(takeoff.scopeSummary ? {scopeSummary:string(takeoff.scopeSummary,"takeoff scope",500)} : {}),
        ...(takeoff.drawingStatus ? {drawingStatus:string(takeoff.drawingStatus,"drawing status",220)} : {}),
        ...(takeoff.checkedBy ? {checkedBy:string(takeoff.checkedBy,"takeoff reviewer",160)} : {}),
      }} : {}),
      unpriced: (benchmark.unpriced as unknown[]).map(value => string(value, "open cost", 500)),
    } } : {}),
    customer: string(draft.customer, "customer", 500, requireText),
    jobName: string(draft.jobName, "job name", 500, requireText),
    notes: string(draft.notes ?? "", "customer notes", 50000, false),
    marginPercent: decimal(draft.marginPercent, "Target gross margin", 99.9999),
    ...(draft.scrapBufferPct==null?{}:{scrapBufferPct:decimal(draft.scrapBufferPct,"Material scrap buffer percent",100)}),
    items,
  };
}

// Reopening a list or review often reads the same immutable price inputs several times.
const priceCache = new Map<string, QuoteTotals>();
function price(draft: QuoteDraft): QuoteTotals {
  const input = {
    marginPercent: draft.marginPercent,
    scrapBufferPct: draft.scrapBufferPct ?? 0,
    ...(draft.benchmark?.takeoff ? {contingencyPercent:draft.benchmark.takeoff.contingencyPercent} : {}),
    ...(draft.benchmark?.takeoff?.scope === "installed" ? {showShopOption:true} : {}),
    items: draft.items.map(({ id, quantity, costRows }) => ({
      id, quantity,
      costRows: costRows.map(row => ({
        id: row.id, amount: row.amount, rate: row.rate, basis: row.basis,
        minimumCost: row.estimate?.minimumCost ?? 0,
        unitCost: row.review?.unitCost, material: isStockMaterial(row),
        ...(draft.benchmark?.takeoff?.scope === "installed" && row.estimate?.workType === "Site & delivery" ? {site:true} : {}),
      })),
    })),
  };
  const key = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const saved = priceCache.get(key);
  if (saved) return structuredClone(saved);
  try {
    const totals = runPricing<QuoteTotals>({ operation: "price", draft: input });
    if (priceCache.size >= 128) priceCache.delete(priceCache.keys().next().value!);
    priceCache.set(key, totals);
    return structuredClone(totals);
  } catch (error) {
    if (error instanceof EngineeringInputError) throw new QuoteError(error.message, 422);
    throw error;
  }
}

export function calculateQuote(input: unknown): QuoteTotals {
  return price(readDraft(input, false));
}

const demo: QuoteDraft = {
  customer: "Ridgeline Fabrication",
  jobName: "Mounting plate assembly",
  notes: "Quote ten mounting plates with a single delivery to the customer.",
  marginPercent: 25,
  items: [
    {
      id: "mounting-plates", description: "Fabricated mounting plates", quantity: 10,
      costRows: [
        { id: "material", label: "Plate material", amount: 1, rate: 8, basis: "per_unit" },
        { id: "labor", label: "Fabrication labor (hours)", amount: 1.5, rate: 60, basis: "batch" },
      ],
    },
    {
      id: "delivery", description: "Delivery", quantity: 1,
      costRows: [{ id: "delivery-charge", label: "Local delivery", amount: 1, rate: 30, basis: "batch" }],
    },
  ],
};

function insert(db: DatabaseSync, id: string, draft: QuoteDraft) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO quotes (id, sequence, draft, created_at, updated_at)
    SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ? FROM quotes
  `).run(id, JSON.stringify(draft), now, now);
}

const historyReady = new WeakSet<DatabaseSync>();
function quoteDb(): DatabaseSync {
  const db = getDb();
  if (!historyReady.has(db)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quote_versions (
        id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL, sequence INTEGER NOT NULL,
        draft TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(id,version)
      );
      CREATE TRIGGER IF NOT EXISTS capture_created_quote AFTER INSERT ON quotes BEGIN
        INSERT INTO quote_versions VALUES(NEW.id,NEW.version,NEW.sequence,NEW.draft,NEW.created_at,NEW.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS capture_updated_quote AFTER UPDATE OF version ON quotes WHEN NEW.version != OLD.version BEGIN
        INSERT INTO quote_versions VALUES(NEW.id,NEW.version,NEW.sequence,NEW.draft,NEW.created_at,NEW.updated_at);
      END;
      INSERT OR IGNORE INTO quote_versions SELECT id,version,sequence,draft,created_at,updated_at FROM quotes;
    `);
    if (!db.isTransaction) historyReady.add(db);
  }
  if (!db.prepare("SELECT 1 FROM app_meta WHERE name = 'demo_v1'").get()) {
    const nested = db.isTransaction;
    db.exec(nested ? "SAVEPOINT seed_quote" : "BEGIN IMMEDIATE");
    try {
      const claim = db.prepare("INSERT OR IGNORE INTO app_meta VALUES ('demo_v1', '1')").run();
      if (claim.changes && !db.prepare("SELECT 1 FROM quotes LIMIT 1").get()) {
        insert(db, "demo-mounting-plate", demo);
      }
      db.exec(nested ? "RELEASE seed_quote" : "COMMIT");
    } catch (error) {
      db.exec(nested ? "ROLLBACK TO seed_quote; RELEASE seed_quote" : "ROLLBACK");
      throw error;
    }
  }
  return db;
}

type RecordRow = NonNullable<ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>>;

function hydrate(row: RecordRow): Quote {
  const draft = JSON.parse(String(row.draft)) as QuoteDraft;
  return {
    ...draft,
    id: String(row.id),
    number: `QT-${String(row.sequence).padStart(4, "0")}`,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    totals: price(draft),
  };
}

export function listQuotes(): Quote[] {
  return quoteDb().prepare("SELECT * FROM quotes ORDER BY updated_at DESC, sequence DESC").all().map(hydrate);
}

export function getQuote(id: string): Quote | null {
  const row = quoteDb().prepare("SELECT * FROM quotes WHERE id = ?").get(id);
  return row ? hydrate(row) : null;
}

export function getQuoteVersion(id: string, version: number): Quote | null {
  const row = quoteDb().prepare("SELECT * FROM quote_versions WHERE id = ? AND version = ?").get(id, version);
  return row ? hydrate(row) : null;
}

export function listQuoteVersions(id: string): Quote[] {
  return quoteDb().prepare("SELECT * FROM quote_versions WHERE id = ? ORDER BY version DESC").all(id).map(hydrate);
}

export function createQuote(input: unknown): Quote {
  const draft = readDraft(input, true);
  price(draft);
  const id = randomUUID();
  insert(quoteDb(), id, draft);
  return getQuote(id)!;
}

export function updateQuote(id: string, input: unknown): Quote {
  const version = object(input, "quote").version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new QuoteError("A saved quote version is required.");
  }
  const draft = readDraft(input, true);
  const previous = getQuote(id);
  if (!previous) throw new QuoteError("Quote not found.", 404);
  if (version !== previous.version) throw new QuoteError("This quote has changed. Reopen the saved draft before saving again.", 409);
  for (const item of draft.items) {
    const previousRows = new Map(previous.items.find(i => i.id === item.id)?.costRows.map(r => [r.id, r]));
    for (const row of item.costRows) {
      const saved = previousRows.get(row.id);
      if (saved?.review?.unitCost !== row.review?.unitCost && !(row.review?.reason || row.estimate?.overrideReason)?.trim())
        throw new QuoteError("Enter a reason for the cost change on " + row.label + ".");
      if (!saved?.estimate) continue;
      if (!row.estimate) throw new QuoteError("Keep the saved template basis on " + row.label + " or replace the row.");
      if (changedEstimateInputs(saved, row) && !row.estimate.overrideReason.trim()) {
        throw new QuoteError("Explain the manual allowance or pricing change for " + row.label + ".");
      }
      // Keep the original source and baseline when editing an existing operation.
      const { unit, includes, minimumCost, assumption, overrideReason } = row.estimate;
      row.estimate = { ...saved.estimate, unit, includes, minimumCost, assumption, overrideReason };
    }
  }
  price(draft);
  const db = quoteDb();
  const row = db.prepare(`
    UPDATE quotes SET draft = ?, updated_at = ?, version = version + 1
    WHERE id = ? AND version = ? RETURNING *
  `).get(JSON.stringify(draft), new Date().toISOString(), id, version);
  if (row) return hydrate(row);
  if (!getQuote(id)) throw new QuoteError("Quote not found.", 404);
  throw new QuoteError("This quote has changed. Reopen the saved draft before saving again.", 409);
}
