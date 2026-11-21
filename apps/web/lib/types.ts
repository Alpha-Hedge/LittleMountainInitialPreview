export type CostBasis = "batch" | "per_unit";
export type RateCategory = "material" | "setup" | "labor" | "machine" | "outside";
export type QuantityDriver = "fixed" | "holes" | "area_m2" | "length_m";

/** Frozen inputs from the rate book and the specification at estimation time. */
export interface RowEstimate {
  category: RateCategory;
  unit: string;
  includes: string;
  minimumCost: number;
  settingsVersion: number;
  rateSettingsVersion?: number;
  rateSource?: string;
  rateEffectiveOn?: string;
  rateId: string;
  templateId: string;
  templateName: string;
  operationId: string;
  workType: string;
  driver: QuantityDriver;
  coefficient: number;
  rationale: string;
  assumption: string;
  overrideReason: string;
  baselineAmount: number;
  baselineRate: number;
  demo: boolean;
  reviewedRevisionId: string | null;
  reviewRunId: string | null;
}

export interface CostRow {
  id: string;
  label: string;
  amount: number;
  rate: number;
  basis: CostBasis;
  estimate?: RowEstimate;
  bufferMaterial?: boolean;
  review?: {unitCost?:number; reason:string; disposition:"standard"|"one_time"};
}

export function isStockMaterial(row:CostRow):boolean {
  if(row.bufferMaterial!==undefined)return row.bufferMaterial;
  if(/\b(filler|shielding gas|weld wire|electrodes?)\b/i.test(row.label))return false;
  return row.estimate ? row.estimate.category==="material" : /\b(material|sheet stock|plate stock|raw stock|steel plate)\b/i.test(row.label);
}

export function changedEstimateInputs(previous: CostRow | undefined, next: CostRow): boolean {
  if (!previous?.estimate || !next.estimate) return false;
  return previous.amount !== next.amount || previous.rate !== next.rate || previous.basis !== next.basis ||
    previous.estimate.minimumCost !== next.estimate.minimumCost || previous.estimate.unit !== next.estimate.unit ||
    previous.estimate.includes !== next.estimate.includes || previous.review?.unitCost !== next.review?.unitCost;
}

export interface LineItem {
  id: string;
  description: string;
  quantity: number;
  quantityPending?: boolean;
  costRows: CostRow[];
}

export interface QuoteDraft {
  scrapBufferPct?:number;
  benchmark?: { name: string; date: string; unpriced: string[]; demo?: boolean;
    takeoff?: { id: string; revisionId: string; scope: "shop" | "installed"; contingencyPercent: number;
      scopeSummary?: string; drawingStatus?: string; checkedBy?: string } };
  customer: string;
  jobName: string;
  notes: string;
  marginPercent: number;
  items: LineItem[];
}

export interface QuoteTotals {
  estimatedCost: number;
  sellingPrice: number;
  contingencyCost?: number;
  shopOnlySellingPrice?: number;
  items: {
    id: string;
    cost: number;
    contingencyCost?: number;
    scrapCost?:number;
    rows: { id: string; cost: number }[];
  }[];
}

export interface Quote extends QuoteDraft {
  id: string;
  number: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  totals: QuoteTotals;
}

export function newCostRow(): CostRow {
  return { id: crypto.randomUUID(), label: "", amount: 1, rate: 0, basis: "per_unit" };
}

export function newLineItem(): LineItem {
  return { id: crypto.randomUUID(), description: "", quantity: 1, costRows: [newCostRow()] };
}

export function newQuoteDraft(marginPercent = 25): QuoteDraft {
  return { customer: "", jobName: "", notes: "", marginPercent, items: [newLineItem()] };
}
