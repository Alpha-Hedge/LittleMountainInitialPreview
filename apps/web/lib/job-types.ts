export const actualKinds = ["setup", "labor", "machine", "material", "outside"] as const;
export type ActualKind = (typeof actualKinds)[number];
export interface ActualRow {
  extendedCost?: number | null;
  itemId: string;
  kind: ActualKind;
  operation: string;
  amount: number;
  unit: string;
  unitCost: number | null;
  exceptionReason?: string;
}
export interface JobRecord {
  quoteId: string;
  version: number;
  edit: number;
  rows: ActualRow[];
  scopeChanges: string;
  overrideReasons: string;
  completedOn: string;
}
export function isTime(kind: string) {
  return ["setup", "labor", "machine"].includes(kind);
}
export interface Comparable {
  sourceWorkspace?: string;
  evidenceHref?: string;
  quoteId: string;
  version: number;
  number: string;
  jobName: string;
  lineId: string;
  description: string;
  workType: string;
  material: string;
  dimensions: string;
  quantity: number;
  operations: { label: string; kind: string; amount: number; unit: string; basis: string }[];
  reasons: string[];
  score: number;
  completed: boolean;
  completedEdit?: number;
  actuals: ActualRow[];
  scopeChanges: string;
  overrideReasons: string;
  pricing?: {
    firstAvailableVersion: number;
    firstSellingPrice: number;
    firstMarginPercent: number;
    firstPricedVersion?: number;
    firstPricedSellingPrice?: number;
    firstPricedMarginPercent?: number;
    approvedSellingPrice: number;
    approvedMarginPercent: number;
    approvedAt: string;
    decision?: { kind: "standard" | "one_time" | "recurring" | "scope_change"; reason: string };
  };
}
