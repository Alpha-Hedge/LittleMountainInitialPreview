import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { getQuote, QuoteError, updateQuote } from "./quotes";
import { runPython, runPricing, EngineeringInputError } from "./python-engine";
import { catalogRequest } from "./engineering-catalog";
import type { RoutingStock, RoutingOperation } from "./routing-types";
import type { CostRow } from "./types";

interface Result {
  sheetCount: number; piecesPerSheet: number; yieldPercent: number; materialCost: number;
  operationHours: { name: string; setupHours: number; runHours: number; totalHours: number }[];
  rows: Omit<CostRow, "id">[]; total: number;
}

function storage() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_routings (
    quote_id TEXT NOT NULL REFERENCES quotes(id), item_id TEXT NOT NULL, version INTEGER NOT NULL,
    inputs TEXT NOT NULL, row_ids TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(quote_id,item_id,version)
  )`);
  return db;
}

export function savedRouting(id: string, itemId: string, version?: number) {
  const row = storage().prepare(`SELECT version,inputs,row_ids,result FROM engineering_routings
    WHERE quote_id=? AND item_id=? AND version<=? ORDER BY version DESC LIMIT 1`).get(id, itemId, version ?? Number.MAX_SAFE_INTEGER);
  return row ? { ...JSON.parse(String(row.inputs)), result: JSON.parse(String(row.result)), quoteVersion: Number(row.version), rowIds: JSON.parse(String(row.row_ids)) as string[] } : null;
}

export async function calculateRouting(id: string, input: Record<string, unknown>) {
  const quote = getQuote(id);
  const item = quote?.items.find(entry => entry.id === input.itemId);
  if (!quote || !item) throw new QuoteError("Choose a saved quote line.", 404);
  if (quote.version !== input.quoteVersion) throw new QuoteError("This quote changed. Reopen the line before calculating.", 409);
  if (input.action !== "preview" && input.action !== "apply") throw new QuoteError("Choose preview or apply.");
  const stock = { ...(input.stock as RoutingStock) };
  if (!Array.isArray(input.operations)) throw new QuoteError("Choose the work-center operations.");
  const operations = input.operations as RoutingOperation[];
  const selected = !!stock.materialId || operations.some(op => op.centerId);
  const catalog = selected ? await catalogRequest() : null;
  let stockSource = null;
  const centerSources = operations.map(op => {
    if (!op.centerId) return null;
    const source = catalog?.work_centers.find(c => c.id === op.centerId);
    if (!source) throw new QuoteError("Select the current work-center rate, or choose manual entry.",409);
    const changed = Number(source.hourly_rate) !== op.hourlyRate || Number(source.default_setup_minutes) !== op.setupMinutes;
    if (changed && (typeof op.overrideReason !== "string" || !op.overrideReason.trim() || op.overrideReason.length > 1000))
      throw new QuoteError("Explain the adjustment to the saved shop rate or setup on " + source.name + ".",422);
    return source;
  });
  let result: Result;
  try {
    if (stock.materialId) {
      const material = catalog?.materials.find(m => m.id === stock.materialId);
      if (!material) throw new QuoteError("Select the current supplier price, or enter a sheet price.",409);
      const sheet = runPricing<{weightLb:number;cost:number}>({ operation:"sheet", width:stock.width,
        height:stock.height, thickness:stock.thicknessMm, density:material.density_lb_per_in3, price:material.cost_per_lb });
      stock.sheetCost = sheet.cost;
      stockSource = { material, ...sheet };
    }
    const { materialId: _material, thicknessMm: _thickness, ...dimensions } = stock;
    result = await runPython<Result>("packages.costing.routing", { stock:dimensions,
      operations:operations.map(({centerId: _id, overrideReason: _reason, ...op}, i)=>({
        ...op, efficiencyFactor: Number(centerSources[i]?.efficiency_factor ?? 1),
      })), quantity: item.quantity });
  }
  catch (error) {
    if (error instanceof EngineeringInputError) throw new QuoteError(error.message, 422);
    throw error;
  }
  const inputs = { stock, operations, stockSource, centerSources };
  if (input.action === "preview") return { ...result, sheetCost: stock.sheetCost };
  const db = storage();
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = new Set(savedRouting(id, item.id, quote.version)?.rowIds ?? []);
    const rows = result.rows.map(row => ({ ...row, id: randomUUID() }));
    const items = quote.items.map(line => line.id !== item.id ? line : {
      ...line, costRows: [...line.costRows.filter(row => !previous.has(row.id)), ...rows],
    });
    const saved = updateQuote(id, { ...quote, items });
    db.prepare("INSERT INTO engineering_routings VALUES(?,?,?,?,?,?)").run(id, item.id, saved.version,
      JSON.stringify({ ...inputs, quantity: item.quantity }), JSON.stringify(rows.map(row => row.id)), JSON.stringify(result));
    db.exec("COMMIT");
    return { ...result, quoteVersion: saved.version };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
