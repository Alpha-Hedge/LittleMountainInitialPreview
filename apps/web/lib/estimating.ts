import { runPricing } from "./python-engine";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { getDrawingState } from "./drawings";
import { getQuote, updateQuote, QuoteError } from "./quotes";
import { listReviews } from "./reviews";
import { fieldKeys, type FieldKey } from "./review-types";
import type { CostRow, QuantityDriver, RateCategory } from "./types";
import type { EstimatingProfiles, EstimatingSettings, OperationSuggestion, RateRevision, ShopRate, TemplateOperation } from "./estimating-types";
import { budgetRoles, drawingRoles, effectiveRate, hourlyCostLabels, hourlyTotal, rateGroups, stockForms, type HourlyCost } from "./estimating-types";
import { practiceRates, practiceTemplates } from "./practice-rate-book";
export type { EstimatingSettings, OperationSuggestion, ShopRate, TemplateOperation, EstimateTemplate } from "./estimating-types";

const demo: EstimatingSettings = {
  version: 1, demo: true,
  rates: [
    { id: "plate-stock", name: "Plate stock", category: "material", unit: "part", value: 8, minimumCost: 0, includes: "One standard steel blank. Confirm grade and supplier price." },
    { id: "shop-setup", name: "Bench setup", category: "setup", unit: "hour", value: 60, minimumCost: 15, includes: "Operator time for staging, layout and fixture setup." },
    { id: "fab-labor", name: "Fabrication labor", category: "labor", unit: "hour", value: 60, minimumCost: 0, includes: "Hands-on fabrication and deburring." },
    { id: "drill-press", name: "Drill press", category: "machine", unit: "hour", value: 40, minimumCost: 5, includes: "Machine occupancy and consumables. Operator time is priced separately." },
  ],
  templates: [
    { id: "plate-fab", name: "Plate fabrication", workType: "Plate fabrication", assumption: "One setup per batch and standard shop handling.", operations: [
      { id: "blank", label: "Cut blank", rateId: "plate-stock", amount: 1, basis: "per_unit", driver: "fixed", assumption: "One blank for each finished part." },
      { id: "layout", label: "Set up and lay out", rateId: "shop-setup", amount: 0.25, basis: "batch", driver: "fixed", assumption: "One shared fixture setup." },
      { id: "finish", label: "Fabricate and deburr", rateId: "fab-labor", amount: 0.1, basis: "per_unit", driver: "fixed", assumption: "Six minutes of hands-on work per part." },
    ] },
    { id: "drilled-plate", name: "Drilled plate", workType: "Drilled plate", assumption: "Rectangular blanks and one drill setup.", operations: [
      { id: "drill-setup", label: "Set up drill press", rateId: "shop-setup", amount: 0.25, basis: "batch", driver: "fixed", assumption: "" },
      { id: "drilling", label: "Drill hole pattern", rateId: "drill-press", amount: 0.05, basis: "per_unit", driver: "holes", assumption: "Three minutes of machine time per specified hole." },
    ] },
  ],
};

type Snapshot = EstimatingSettings & { activeDemo?: boolean; practiceEdition?: number };
const practiceEdition = 1;
const practiceBook: Snapshot = {
  ...demo, practiceEdition, defaultMargin:25, stockTrimPercent:12,
  rates:[...demo.rates,...practiceRates], templates:[...demo.templates,...practiceTemplates],
};

const settingsReady = new WeakSet<DatabaseSync>();
function settingsDb() {
  const db = getDb();
  if (!settingsReady.has(db)) {
    db.exec("CREATE TABLE IF NOT EXISTS estimating_settings (version INTEGER PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO estimating_settings VALUES (1, ?, ?)").run(JSON.stringify(practiceBook), new Date().toISOString());
    const latest = db.prepare("SELECT version,body,created_at FROM estimating_settings ORDER BY version DESC LIMIT 1").get()!;
    const practice = db.prepare("SELECT body,created_at FROM estimating_settings WHERE json_extract(body,'$.demo')=1 ORDER BY version DESC LIMIT 1").get()!;
    const prior = decodeSavedRateBook(practice);
    if (prior.practiceEdition !== practiceEdition) {
      const active = decodeSavedRateBook(latest);
      const next: Snapshot = {...practiceBook, ...prior, version:Number(latest.version)+1,
        activeDemo:active.activeDemo ?? active.demo, practiceEdition,
        rates:[...prior.rates,...practiceRates.filter(rate=>!prior.rates.some(old=>old.id===rate.id))],
        templates:[...prior.templates,...practiceTemplates.filter(template=>!prior.templates.some(old=>old.id===template.id))]};
      db.prepare(`INSERT INTO estimating_settings SELECT ?,?,?
        WHERE (SELECT MAX(version) FROM estimating_settings)=?`)
        .run(next.version,JSON.stringify(next),new Date().toISOString(),Number(latest.version));
    }
    if (!db.isTransaction) settingsReady.add(db);
  }
  return db;
}

const shopCalendar = new Intl.DateTimeFormat("en-CA", {
  year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/New_York",
});
export function shopDate(at = new Date()) { return shopCalendar.format(at); }

export function decodeSavedRateBook(row: Record<string, unknown>): Snapshot {
  const book: Snapshot = JSON.parse(String(row.body));
  const savedOn = shopDate(new Date(String(row.created_at)));
  return {...book,rates:book.rates.map(rate => ({
    ...rate,
    source: rate.source ?? (book.demo ? "Demo rate book" : "Legacy shop rate"),
    effectiveOn: rate.effectiveOn ?? savedOn,
  }))};
}
export function getEstimatingSettings(): EstimatingSettings {
  const profiles = getEstimatingProfiles();
  return profiles[profiles.active];
}

export function getEstimatingProfiles(): EstimatingProfiles {
  const db = settingsDb();
  const rows = db.prepare(`SELECT version,body,created_at FROM estimating_settings WHERE version IN (
    SELECT MAX(version) FROM estimating_settings GROUP BY json_extract(body,'$.demo')
  ) ORDER BY version DESC`).all().map(decodeSavedRateBook);
  const latest = rows[0];
  const atHead = (book: Snapshot): EstimatingSettings => {
    const {activeDemo: _active, practiceEdition: _edition, ...profile} = book;
    return {...profile, profileVersion:book.version, version:latest.version};
  };
  return {active:(latest.activeDemo ?? latest.demo) ? "practice" : "shop",
    practice:atHead(rows.find(book=>book.demo)!),
    shop:atHead(rows.find(book=>!book.demo) ?? {version:latest.version,demo:false,rates:[],templates:[]})};
}

export function getRateHistory(): RateRevision[] {
  const snapshots = settingsDb().prepare("SELECT body,created_at FROM estimating_settings ORDER BY version").all();
  const history: RateRevision[] = [];
  const previous = new Map<boolean,Map<string,string>>([[true,new Map()],[false,new Map()]]);
  for (const row of snapshots) {
    const book = decodeSavedRateBook(row);
    const fingerprints = previous.get(book.demo)!;
    for (const rate of book.rates) {
      const fingerprint = JSON.stringify(Object.entries(rate).sort(([a],[b])=>a.localeCompare(b)));
      if (fingerprints.get(rate.id) === fingerprint) continue;
      fingerprints.set(rate.id,fingerprint);
      history.push({...rate,source:rate.source!,effectiveOn:rate.effectiveOn!,version:book.version,recordedAt:String(row.created_at),demo:book.demo});
    }
    const ids = new Set(book.rates.map(r => r.id));
    for (const id of fingerprints.keys()) if (!ids.has(id)) fingerprints.delete(id);
  }
  return history.sort((a,b) => b.effectiveOn.localeCompare(a.effectiveOn) || b.version-a.version);
}

function checkedDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) {
    throw new QuoteError("Enter a valid effective date for the rate.");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new QuoteError("Invalid estimating settings.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, optional = false, limit = 500): string {
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > limit) throw new QuoteError("Check " + name + ".");
  return value.trim();
}
function numeric(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > 1e9 || !/^\d+(\.\d{1,4})?$/.test(String(value))) {
    throw new QuoteError(name + " must be nonnegative with up to four decimal places.");
  }
  return value;
}
function collection(value: unknown, name: string, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > 500) throw new QuoteError("Enter between " + min + " and 500 " + name + ".");
  return value.map(record);
}
function uniqueIds(list: {id: string}[], name: string) {
  if (new Set(list.map(e => e.id)).size !== list.length) throw new QuoteError("Duplicate " + name + " ID.");
}

function appendSettings(next: Snapshot, expected: number) {
  const write = settingsDb().prepare(`INSERT INTO estimating_settings (version,body,created_at)
    SELECT ?,?,? WHERE (SELECT MAX(version) FROM estimating_settings)=?`).run(next.version,JSON.stringify(next),new Date().toISOString(),expected);
  if (!write.changes) throw new QuoteError("The rate book changed. Reopen settings before saving.",409);
}

export function selectEstimatingProfile(input: unknown): EstimatingProfiles {
  const value = record(input);
  const profiles = getEstimatingProfiles();
  if (value.profile !== "practice" && value.profile !== "shop") throw new QuoteError("Choose a pricing profile.");
  const selected = profiles[value.profile];
  if (selected.version !== value.version) throw new QuoteError("The rate book changed. Reopen settings before switching.",409);
  if (profiles.active === value.profile) return profiles;
  if (!selected.rates.some(rate=>effectiveRate(getRateHistory(),rate.id,selected.demo,shopDate())?.value))
    throw new QuoteError("Enter at least one current shop price before switching.",422);
  appendSettings({...selected,profileVersion:undefined,version:selected.version+1,activeDemo:selected.demo,
    ...(selected.demo ? {practiceEdition} : {})}, selected.version);
  return getEstimatingProfiles();
}

function optionalChoice<T extends string>(value: unknown, choices: readonly T[], label: string): T | undefined {
  if (value == null || value === "") return undefined;
  if (!choices.includes(value as T)) throw new QuoteError("Check " + label + ".");
  return value as T;
}

export function saveEstimatingSettings(input: unknown, preserveActive = false): EstimatingSettings {
  const value = record(input);
  if (typeof value.demo !== "boolean" || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new QuoteError("Supply the saved settings version and demo status.");
  }
  const current = getEstimatingProfiles();
  const activeDemo = preserveActive ? current.active === "practice" : value.demo;
  const rates = collection(value.rates, "rates", 0).map((r): ShopRate => {
    const category = r.category as RateCategory;
    if (!["material","setup","labor","machine","outside"].includes(category)) throw new QuoteError("Choose a rate category.");
    const unit = text(r.unit,"rate unit",false,100);
    const hourlyInput = r.hourlyCost === undefined ? undefined : record(r.hourlyCost);
    const hourlyCost = hourlyInput && unit.toLowerCase() === "hour" ?
      Object.fromEntries(Object.entries(hourlyCostLabels).map(([key,label])=>[key,numeric(hourlyInput[key],label)])) as HourlyCost : undefined;
    const price = numeric(r.value,"Rate");
    if (hourlyCost && hourlyTotal(hourlyCost) !== price)
      throw new QuoteError("Use the hourly breakdown total as the rate, or remove the breakdown.");
    const budgetRole = optionalChoice(r.budgetRole,budgetRoles,"drawing budget operation");
    if (budgetRole && unit.toLowerCase() !== drawingRoles[budgetRole][1])
      throw new QuoteError("Use “" + drawingRoles[budgetRole][1] + "” as the unit for " + drawingRoles[budgetRole][0] + ".");
    return { id: text(r.id,"rate ID",false,128), name: text(r.name,"rate name"), category,
      unit, includes: text(r.includes,"what the rate includes",false,3000),
      value: price, minimumCost: numeric(r.minimumCost,"Minimum charge"), hourlyCost,
      source: text(r.source ?? (value.demo ? "Demo rate book" : "Shop rate"), "rate source"),
      effectiveOn: checkedDate(r.effectiveOn ?? shopDate()),
      group: optionalChoice(r.group,rateGroups,"rate group"),
      grade:r.grade ? text(r.grade,"grade",true,100) : undefined,
      family:r.family ? text(r.family,"material family",true,100) : undefined,
      form:optionalChoice(r.form,stockForms,"stock form"),
      density:r.density === undefined ? undefined : numeric(r.density,"Density"),
      thicknessIn:r.thicknessIn === undefined ? undefined : numeric(r.thicknessIn,"Stock thickness"),
      budgetRole,
      budgetAmount:r.budgetAmount === undefined ? undefined : numeric(r.budgetAmount,"Drawing quantity allowance") };
  });
  uniqueIds(rates,"rate");
  uniqueIds(rates.flatMap(rate=>rate.budgetRole ? [{id:rate.budgetRole}] : []),"drawing operation. Assign each operation to one rate");
  const templates = collection(value.templates,"templates",0).map(t => {
    const operations = collection(t.operations,"operations").map((o): TemplateOperation => {
      const driver = o.driver as QuantityDriver;
      if (!["fixed","holes","length_m","area_m2"].includes(driver) || (o.basis !== "batch" && o.basis !== "per_unit")) {
        throw new QuoteError("Choose an amount rule and application basis for every operation.");
      }
      if (!rates.some(r => r.id === o.rateId)) throw new QuoteError("An operation references a missing rate. Choose its rate before saving.");
      return { id: text(o.id,"operation ID",false,128), label: text(o.label,"operation label"), rateId: String(o.rateId),
        basis: o.basis, driver, amount: numeric(o.amount,"Operation allowance"), assumption: text(o.assumption,"operation assumption",true,3000) };
    });
    uniqueIds(operations,"operation");
    return { id: text(t.id,"template ID",false,128), name: text(t.name,"template name"), workType: text(t.workType,"work type"),
      assumption: text(t.assumption,"template assumption",true,3000), operations };
  });
  uniqueIds(templates,"template");
  const today = shopDate();
  const history = getRateHistory();
  const used = new Set(templates.flatMap(t => t.operations.map(o => o.rateId)));
  for (const rate of rates) {
    if (used.has(rate.id) && rate.effectiveOn! > today &&
        !effectiveRate(history, rate.id, value.demo, today)) {
      throw new QuoteError("Enter a current price for " + rate.name + " before scheduling its first template rate.");
    }
  }
  const defaultMargin = numeric(value.defaultMargin ?? 25,"Default margin");
  const stockTrimPercent = numeric(value.stockTrimPercent ?? 12,"Stock trim allowance");
  const budgetContingencyPercent = numeric(value.budgetContingencyPercent ?? (value.demo ? 15 : 0),"Budget contingency");
  if (defaultMargin >= 100 || stockTrimPercent > 100 || budgetContingencyPercent > 100)
    throw new QuoteError("Enter a margin under 100% and allowances between 0% and 100%.");
  const next = { version: value.version + 1, demo: value.demo, rates, templates, defaultMargin, stockTrimPercent, budgetContingencyPercent };
  appendSettings({...next,activeDemo,...(value.demo ? {practiceEdition} : {})},value.version);
  return next;
}

export function getReviewedItemSpec(quoteId: string, itemId: string) {
  const selectedRevisionId = getDrawingState(quoteId).selectedRevisionId;
  const fields: Partial<Record<FieldKey,string>> = {};
  if (selectedRevisionId) {
    const runs = listReviews(quoteId,selectedRevisionId);
    const applied = getDb().prepare(`SELECT a.run_id, a.part_index FROM review_applied_items a
      JOIN review_runs r ON r.id = a.run_id JOIN review_edits e ON e.run_id=r.id AND e.action='apply'
      WHERE r.quote_id=? AND r.revision_id=? AND a.item_id=? ORDER BY e.rowid DESC LIMIT 1`).get(quoteId,selectedRevisionId,itemId);
    const run = runs.find(r => r.id === applied?.run_id);
    if (run && applied) {
      const index = Number(applied.part_index);
      for (const key of fieldKeys) {
        const f = run.parts[index].fields[key];
        const v = run.corrections[index].values[key] ?? (f.status === "found" ? f.value : "");
        if (v) fields[key] = v;
      }
      return { fields, selectedRevisionId, reviewedRevisionId: selectedRevisionId, reviewRunId: run.id };
    }
  }
  return { fields, selectedRevisionId, reviewedRevisionId:null, reviewRunId:null };
}

export function suggestOperations(quoteId: string, itemId: string, templateId: string): OperationSuggestion {
  const quote = getQuote(quoteId);
  const item = quote?.items.find(entry => entry.id === itemId);
  if (!quote || !item) throw new QuoteError("Quote line not found.",404);
  const settings = getEstimatingSettings();
  const template = settings.templates.find(t => t.id === templateId);
  if (!template) throw new QuoteError("Template not found.",404);
  const spec = getReviewedItemSpec(quoteId,itemId);
  const missingOperationIds: string[] = [];
  const pricingDate = shopDate();
  const history = getRateHistory();
  const allowances = runPricing<{ factor: number | null; amount: number; basis: string }[]>({
    operation: "allowances", fields: spec.fields, operations: template.operations.map(op => ({ driver: op.driver, amount: op.amount })),
  });
  const rows: CostRow[] = template.operations.map((op, index) => {
    const rate = effectiveRate(history,op.rateId,settings.demo,pricingDate);
    if (!rate) throw new QuoteError("Enter a current rate in settings for " + op.label + ".");
    const { factor, basis, amount } = allowances[index];
    if (factor === null) missingOperationIds.push(op.id);
    const allowance = op.driver === "fixed" ? `${op.amount} ${rate.unit}` : `${op.amount} ${rate.unit} × ${factor ?? "unconfirmed measurement"}`;
    return { id: randomUUID(), label: op.label, amount, rate: rate.value, basis:op.basis,
      estimate:{ category: rate.category, unit:rate.unit, includes:rate.includes, minimumCost:rate.minimumCost, settingsVersion:settings.profileVersion??settings.version,
        rateSource:rate.source, rateEffectiveOn:rate.effectiveOn, rateSettingsVersion:rate.version,
        rateId:rate.id, templateId, templateName:template.name, operationId:op.id, workType:template.workType, driver:op.driver, coefficient:op.amount,
        rationale:`${basis}. ${allowance} ${op.basis === "batch" ? "for this batch" : "per part"}.`,
        assumption:[template.assumption,op.assumption].filter(Boolean).join(" "), overrideReason:"", baselineAmount:amount, baselineRate:rate.value,
        demo:settings.demo, reviewedRevisionId:spec.reviewedRevisionId, reviewRunId:spec.reviewRunId } };
  });
  return {...spec, rows, missingOperationIds, settingsVersion:settings.version, quoteVersion:quote.version, pricingDate};
}

export function applyOperations(quoteId: string, input: unknown) {
  const value = record(input);
  const itemId = text(value.itemId,"quote line ID",false,128);
  const templateId = text(value.templateId,"template ID",false,128);
  const db = getDb();
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT apply_operations" : "BEGIN IMMEDIATE");
  try {
    const quote = getQuote(quoteId);
    if (!quote || quote.version !== value.quoteVersion) throw new QuoteError("The quote changed. Reopen the estimate builder.",409);
    const suggestion = suggestOperations(quoteId,itemId,templateId);
    if (suggestion.settingsVersion !== value.settingsVersion || suggestion.selectedRevisionId !== value.selectedRevisionId ||
        (value.pricingDate !== undefined && value.pricingDate !== suggestion.pricingDate)) {
      throw new QuoteError("The rate book or selected drawing changed. Generate a fresh estimate.",409);
    }
    const included = new Set<string>();
    const rows = collection(value.rows,"selected operations").map(draft => {
      const edits = record(draft.estimate);
      const original = suggestion.rows.find(row => row.estimate!.operationId === edits.operationId);
      if (!original || included.has(original.estimate!.operationId)) throw new QuoteError("Choose each template operation at most once.");
      const e = original.estimate!;
      included.add(e.operationId);
      const reason = text(edits.overrideReason,"override reason",true,8000);
      const changed = draft.amount !== original.amount || draft.rate !== original.rate || draft.basis !== original.basis ||
        edits.minimumCost !== e.minimumCost || edits.unit !== e.unit || edits.includes !== e.includes;
      if ((changed || suggestion.missingOperationIds.includes(e.operationId)) && !reason) throw new QuoteError("Explain the manual allowance or pricing change for " + original.label + ".");
      return { ...original, label: draft.label, amount: draft.amount, rate: draft.rate, basis:draft.basis,
        estimate:{...e, minimumCost:edits.minimumCost, unit:edits.unit, includes:edits.includes, assumption:edits.assumption, overrideReason:reason} };
    });
    const items = quote.items.map(item => item.id === itemId ? {...item, costRows:[
      ...item.costRows.filter(row => !row.estimate && value.keepManual !== false), ...rows,
    ]} : item);
    const result = updateQuote(quoteId,{...quote,items});
    db.exec(nested ? "RELEASE apply_operations" : "COMMIT");
    return result;
  } catch (error) { db.exec(nested ? "ROLLBACK TO apply_operations; RELEASE apply_operations" : "ROLLBACK"); throw error; }
}
