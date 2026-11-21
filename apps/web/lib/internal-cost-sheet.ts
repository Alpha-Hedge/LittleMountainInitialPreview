import type { Quote } from "./types";
import type { CustomerQuote } from "./workflow-types";
import { savedRouting } from "./work-center-routing";
import { getDb } from "./db";

const headings = [
  "Record", "Quote", "Revision", "Customer", "Job", "Line", "Quantity", "Cost description", "Category",
  "Charge basis", "Amount", "Unit", "Rate USD", "Minimum USD", "Row cost USD",
  "Line cost USD", "Line selling price USD", "Quote cost USD", "Quote selling price USD", "Target gross margin %",
  "Routing version", "Routing quantity", "Planned setup hours", "Planned run hours", "Planned batch hours",
  "Rate includes", "Rate source", "Effective date", "Estimate basis", "Override reason", "Override USD per basis", "Override applies to",
] as const;
type Column = (typeof headings)[number];
type Cells = Partial<Record<Column, string | number | null>>;

interface Routing {
  quoteVersion: number;
  quantity: number;
  rowIds: string[];
  result: { operationHours: { setupHours: number; runHours: number; totalHours: number }[] };
}

function csvCell(value: Cells[Column]): string {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  const literal = /^[\s\uFEFF]*[=+@-]/u.test(value) || /^[\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + literal.replaceAll('"', '""') + '"';
}

/** Public prices are the same frozen allocation used by the customer document. */
export function renderInternalCostSheet(quote: Quote, customer: CustomerQuote,
  routingFor: (lineId: string) => Routing | null = lineId => savedRouting(quote.id, lineId, quote.version)): string {
  const lines: string[] = [headings.map(csvCell).join(",")];
  const root: Cells = { Quote: quote.number, Revision: quote.version, Customer: quote.customer, Job: quote.jobName };
  function append(row: Cells) {
    const cells = { ...root, ...row };
    lines.push(headings.map(key => csvCell(cells[key])).join(","));
  }
  quote.items.forEach((item, i) => {
    const line: Cells = { Line: item.description, Quantity: item.quantity };
    const total = quote.totals.items[i];
    const routing = routingFor(item.id);
    item.costRows.forEach((row, j) => {
      const routeIndex = routing?.rowIds.indexOf(row.id) ?? -1;
      // Routing writes the sheet row first, then each operation in the original order.
      const operation = routeIndex > 0 ? routing?.result.operationHours[routeIndex - 1] : undefined;
      append({
        ...line, Record: "Cost row", "Cost description": row.label, Category: row.estimate?.category ??
          (routeIndex === 0 ? "material" : operation ? "work center" : "manual"),
        "Charge basis": row.basis === "batch" ? "Per batch" : "Per piece", Amount: row.amount,
        Unit: row.estimate?.unit ?? (routeIndex === 0 ? "sheet" : operation ? "hour" : ""),
        "Rate USD": row.rate, "Minimum USD": row.estimate?.minimumCost ?? 0, "Row cost USD": total.rows[j].cost.toFixed(2),
        "Routing version": routeIndex < 0 ? null : routing?.quoteVersion,
        "Routing quantity": routeIndex < 0 ? null : routing?.quantity,
        "Planned setup hours": operation?.setupHours, "Planned run hours": operation?.runHours,
        "Planned batch hours": operation?.totalHours, "Rate includes": row.estimate?.includes,
        "Rate source": row.estimate?.rateSource, "Effective date": row.estimate?.rateEffectiveOn,
        "Estimate basis": row.estimate?.templateId==="drawing-takeoff"
          ? [row.estimate.rationale,row.estimate.assumption,"Rate "+row.estimate.rateId].join(" · ") : row.estimate?.rationale,
        "Override reason": row.review?.reason || row.estimate?.overrideReason,
        "Override USD per basis":row.review?.unitCost,"Override applies to":row.review?.disposition,
      });
    });
    if(total.scrapCost) append({...line,Record:"Material scrap buffer","Cost description":"Extra material allowance ("+quote.scrapBufferPct+"%)","Row cost USD":total.scrapCost.toFixed(2)});
    if(total.contingencyCost) append({...line,Record:"Budget contingency","Row cost USD":total.contingencyCost.toFixed(2)});
    append({ ...line, Record: "Line total", "Line cost USD": total.cost.toFixed(2),
      "Line selling price USD": customer.lines[i].sellingPrice.toFixed(2) });
  });
  append({ Record: "Quote total", "Quote cost USD": quote.totals.estimatedCost.toFixed(2),
    "Quote selling price USD": customer.sellingPrice.toFixed(2), "Target gross margin %": quote.marginPercent });
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

function sheetStore() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS quote_internal_cost_sheets (
    quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
    filename TEXT NOT NULL, csv TEXT NOT NULL, PRIMARY KEY(quote_id, version)
  )`);
  return db;
}

export function frozenInternalCostSheet(id: string, version: number) {
  const row = sheetStore().prepare("SELECT filename,csv FROM quote_internal_cost_sheets WHERE quote_id=? AND version=?").get(id, version);
  return row ? {filename: String(row.filename), csv: String(row.csv)} : null;
}

export function issueInternalCostSheet(quote: Quote, customer: CustomerQuote) {
  const filename = quote.number + "-v" + quote.version + "-internal-costs.csv";
  const csv = renderInternalCostSheet(quote, customer);
  sheetStore().prepare("INSERT OR IGNORE INTO quote_internal_cost_sheets(quote_id,version,filename,csv) VALUES(?,?,?,?)")
    .run(quote.id, quote.version, filename, csv);
}

