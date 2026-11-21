import type { CostBasis, CostRow, QuantityDriver, RateCategory } from "./types";
import type { FieldKey } from "./review-types";

export const rateGroups = ["Stock", "Hardware", "Labor", "Machines", "Consumables", "Finishing", "Outside services", "Field work", "Freight and handling"] as const;
export type RateGroup = typeof rateGroups[number];
export const stockForms = ["sheet / plate", "tube / pipe", "bar", "angle / channel / beam", "mesh / grating"] as const;
export const budgetRoles = ["setup", "blank", "saw", "drill", "form", "weld", "consumables"] as const;
export const hourlyCostLabels = {
  wage:"Direct wage", burden:"Payroll taxes and benefits", overhead:"Shop overhead", equipment:"Machine and equipment",
} as const;
export type HourlyCost = Record<keyof typeof hourlyCostLabels, number>;

export function hourlyTotal(cost: HourlyCost): number {
  return Number(Object.values(cost).reduce((sum,value)=>sum+value,0).toFixed(4));
}

export interface ShopRate {
  id: string;
  name: string;
  category: RateCategory;
  unit: string;
  value: number;
  includes: string;
  minimumCost: number;
  source?: string;
  effectiveOn?: string;
  group?: RateGroup;
  grade?: string;
  form?: typeof stockForms[number];
  family?: string;
  density?: number;
  thicknessIn?: number;
  budgetRole?: typeof budgetRoles[number];
  budgetAmount?: number;
  hourlyCost?: HourlyCost;
}

export const drawingRoles = {
  setup:["Batch layout and setup","hour",.5,"per batch"],
  blank:["Blank cutting","hour",.12,"per piece"],
  saw:["Sawing structural stock","hour",.1,"per piece"],
  drill:["Drilling","hour",.05,"per hole"],
  form:["Forming","hour",.06,"per bend"],
  weld:["Shop fit-up and welding","hour",.25,"per joint"],
  consumables:["Welding consumables","joint",1,"per joint"],
} as const;

export interface RateRevision extends ShopRate {
  source: string;
  effectiveOn: string;
  version: number;
  recordedAt: string;
  demo: boolean;
}
// Rate history arrives newest effective date first, with later corrections winning ties.
export function effectiveRate(history: RateRevision[], id: string, demo: boolean, day: string) {
  return history.find(r => r.id === id && r.demo === demo && r.effectiveOn <= day);
}

export interface TemplateOperation {
  id: string;
  label: string;
  rateId: string;
  amount: number;
  basis: CostBasis;
  driver: QuantityDriver;
  assumption: string;
}

export interface EstimateTemplate {
  id: string;
  name: string;
  workType: string;
  assumption: string;
  operations: TemplateOperation[];
}

export interface EstimatingSettings {
  version: number;
  profileVersion?: number;
  demo: boolean;
  rates: ShopRate[];
  templates: EstimateTemplate[];
  defaultMargin?: number;
  stockTrimPercent?: number;
  budgetContingencyPercent?: number;
}

export interface EstimatingProfiles {
  practice: EstimatingSettings;
  shop: EstimatingSettings;
  active: "practice" | "shop";
}

export interface OperationSuggestion {
  pricingDate?: string;
  rows: CostRow[];
  reviewedRevisionId: string | null;
  reviewRunId: string | null;
  settingsVersion: number;
  quoteVersion: number;
  selectedRevisionId: string | null;
  fields: Partial<Record<FieldKey, string>>;
  missingOperationIds: string[];
}

export const driverLabels: Record<QuantityDriver, string> = {
  fixed: "Fixed allowance", holes: "Per specified hole", area_m2: "Per m² of rectangular blank", length_m: "Per metre of length",
};
