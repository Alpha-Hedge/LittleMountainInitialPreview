import type { Comparable } from "./job-types";
import type { OperationSuggestion } from "./estimating-types";
import type { MeasuredAllowance } from "./measured-allowances";
export type HistoryAwareSuggestion = OperationSuggestion & {
  comparison?: {
    source: string;
    count: number;
    observations: MeasuredAllowance[];
    preferences: ApprovedPricingPreference[];
  };
  comparisonError?: string;
};
export interface ApprovedPricingPreference {
  reason: string;
  approvedMarginPercent: number;
  ref: string;
}
export interface HourAdvice {
  confidence?: number;
  operationId: string;
  hours: number;
  assumption: string;
  basis: string;
  sources: string[];
}
export interface HourEdit {
  operationId: string;
  hours: number;
  assumption: string;
  reason: string;
  recurring: boolean;
}
export interface MeasureEdit {
  operationId: string;
  amount: number;
  reason: string;
}
export interface HistoryRun {
  kind?: "estimate" | "template_review";
  id: string;
  quoteId: string;
  itemId: string;
  templateId: string;
  createdAt: string;
  model: string;
  provider: string;
  base: OperationSuggestion;
  records: Comparable[];
  advice: HourAdvice[];
  appliedVersion: number | null;
  edits: HourEdit[] | null;
  measures?: MeasureEdit[];
  observations?: MeasuredAllowance[];
  recordsSource?: "Supabase" | "Local";
}
export interface AllowanceProposal {
  id: string;
  label: string;
  before: number;
  after: number;
  reason: string;
  status: string;
  unit: string;
  driver: string;
}
