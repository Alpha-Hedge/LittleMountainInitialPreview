export type BlueprintValue =
  | string
  | number
  | boolean
  | null
  | BlueprintValue[]
  | { [key: string]: BlueprintValue };
export type BlueprintObject = { [key: string]: BlueprintValue };
export interface BlueprintSource {
  id: string;
  filename: string;
  revision: number;
  drawing_key: string;
  type: string;
  sha256: string;
}
export interface BlueprintSummary {
  id: string;
  version: number;
  state:
    | "queued"
    | "extracting"
    | "review_required"
    | "costing"
    | "ready"
    | "failed";
  customer_name: string;
  job_name: string;
  drawing: BlueprintSource;
  created_at: string;
  updated_at: string;
}
export interface BlueprintCitation {
  kind: "historical_job" | "nick_rule" | "drawing" | "template";
  reference: string;
  excerpt: string;
}
export interface BlueprintRow {
  id: string;
  label: string;
  category: string;
  stage: string;
  basis: "batch" | "per_unit";
  amount: string;
  rate: string;
  cost_usd: string;
  basis_text: string;
  work_center: string | null;
  citations: string[];
  rule_citations?: BlueprintCitation[];
  unit?: string;
  includes?: string;
  rate_source?: string;
  rate_effective_on?: string | null;
}
export interface BlueprintLine {
  part_id: string;
  description: string;
  quantity: number;
  weight_lb: string;
  material_family: string;
  processes: string[];
  estimated_cost_usd: string;
  selling_price_usd: string;
  rows: BlueprintRow[];
  baseline_rows: BlueprintRow[];
  metrics: BlueprintObject;
  warnings: string[];
  history: {
    quote_id: string;
    quote_number: string;
    revision: number;
    description: string;
    score: number;
    override_reason: string;
    source_workspace?: string;
    completed_edit?: number | null;
    actuals?: string[];
    scope_changes?: string;
    typical?: boolean;
    citation: BlueprintCitation;
    ai_proposed: BlueprintObject | null;
    nick_approved: BlueprintObject | null;
  }[];
  rules: BlueprintCitation[];
}
export interface BlueprintJob extends BlueprintSummary {
  notes: string;
  model: string | null;
  source_check?: { status: "checked" | "incomplete"; model: string | null } | null;
  recovered_fields?: { part_id: string; field: string; value: string | number; page: number | null; evidence: string }[];
  source_callouts?: {page:number; label:string; evidence:string; status:"captured"|"recovered"|"review"; part_id:string|null}[] | null;
  printed_inventory_current?: boolean;
  scope_decisions?: Record<string,"include"|"exclude">;
  shop_scope?: string;
  installation?: "confirm"|"included"|"excluded";
  settings: BlueprintObject;
  ast: BlueprintObject | null;
  original_ast: BlueprintObject | null;
  error: string | null;
  review_log: BlueprintObject[];
  flags: { path: string; kind: string; reason: string }[];
  result: {
    totals: {
      estimated_cost_usd: string;
      selling_price_usd: string;
      gross_margin_pct: string;
    };
    stock_groups: BlueprintObject[];
    lines: BlueprintLine[];
    warnings: string[];
    settings: BlueprintObject;
  } | null;
}
