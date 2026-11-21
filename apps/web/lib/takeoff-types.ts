export type TakeoffScope = "shop" | "installed";
export type TakeoffGroup = "Stock" | "Hardware & consumables" | "Shop fabrication" | "Finishing & outside work" | "Site & delivery";
export type QuantityEvidence = "Explicit" | "Derived" | "Assumed";
export type AutomaticBudgetState =
  | { state: "idle" | "taking_off" | "checking" }
  | { state: "failed"; error: string }
  | { state: "ready"; version: number };

export interface TakeoffPreview {
  id: string;
  scope: TakeoffScope;
  model: string;
  scopeSummary?: string;
  drawingStatus?: string;
  checkedBy?: string;
  directCost: number;
  contingencyCost: number;
  contingencyPercent: number;
  sellingPrice: number;
  shopOnlySellingPrice?: number;
  rows: {
    group: TakeoffGroup;
    label: string;
    part: string;
    amount: number;
    unit: string;
    rate: number;
    rateId: string;
    minimumCost: number;
    cost: number;
    page: number;
    basis: string;
    assumption: string;
    evidence?: QuantityEvidence;
  }[];
  checks: string[];
}
