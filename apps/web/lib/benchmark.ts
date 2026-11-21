import { createHash } from "node:crypto";
import type { BlueprintJob, BlueprintObject } from "./blueprint-types";
import { runPricing } from "./python-engine";
import type { CostRow, QuoteDraft, RowEstimate } from "./types";
import { getEstimatingProfiles, getRateHistory, shopDate } from "./estimating";
import { drawingRoles, effectiveRate, type EstimatingSettings } from "./estimating-types";

export const benchmarkTemplateId = "us-fabrication-benchmark";

type BenchRow = {
  key: string; label: string; amount: number; rate: number; category: RowEstimate["category"];
  basis: CostRow["basis"]; unit: string; includes: string; rationale: string; source: string;
  minimumCost: number; effectiveOn: string; rateRevision: number; rateId: string;
};
type BenchPlan = {
  lines: { id: string; rows: BenchRow[]; checks: string[] }[];
};

export function fillBenchmark(draft: QuoteDraft, job: BlueprintJob, revision: string | null,
  settings: EstimatingSettings = getEstimatingProfiles().practice): QuoteDraft {
  const astParts = Array.isArray(job.ast?.parts) ? job.ast.parts : [];
  const items = new Map(draft.items.filter(item => !item.costRows.length).map(item => [item.id, item]));
  const parts = astParts.flatMap((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const part: BlueprintObject = value;
    const id = String(part.part_id);
    if (!items.has(id)) return [];
    const prefix = "parts." + index + ".";
    const blocked = (job.flags || []).filter(flag => flag.path.startsWith(prefix)
      && ["conflict", "unverified_source"].includes(flag.kind)).map(flag => flag.path.slice(prefix.length));
    return [{ id, part, blocked }];
  });
  if (!parts.length) return draft;

  const date = shopDate();
  const history = getRateHistory();
  const rates = settings.rates.flatMap(entry => {
    const rate = effectiveRate(history,entry.id,settings.demo,date);
    return rate ? [{...rate,budgetAmount:rate.budgetAmount ?? (rate.budgetRole ? drawingRoles[rate.budgetRole][2] : undefined)}] : [];
  });
  const name = settings.demo ? "U.S. shop benchmarks" : "My shop rates · Drawing budget";
  const plan = runPricing<BenchPlan>({
    operation: "benchmark", parts, rates, trimPercent:settings.stockTrimPercent ?? 12, demo:settings.demo,
    existingSetup: draft.items.some(item => item.costRows.some(row => row.estimate?.category === "setup")),
  });
  const unpriced = new Set(draft.benchmark?.unpriced || []);
  const priced = new Map(plan.lines.map(line => {
    const item = items.get(line.id)!;
    const name = item.description.split("\n")[0];
    line.checks.forEach(note => unpriced.add((name + " · " + note).slice(0,500)));
    return [line.id, line.rows.map((row): CostRow => {
      const id = "benchmark-" + createHash("sha256").update(line.id + "/" + row.key).digest("hex").slice(0,24);
      return {
        id, label: row.label, amount: row.amount, rate: row.rate, basis: row.basis,
        bufferMaterial: row.key === "stock",
        estimate: {
          category: row.category, unit: row.unit, includes: row.includes, minimumCost: row.minimumCost,
          settingsVersion: settings.profileVersion ?? settings.version, rateSource: row.source, rateEffectiveOn: row.effectiveOn,
          rateSettingsVersion: row.rateRevision, rateId: row.rateId, templateId: benchmarkTemplateId,
          templateName: name, operationId: row.key, workType: "Fabrication budget",
          driver: "fixed", coefficient: 1, rationale: row.rationale,
          assumption: settings.demo ? "Illustrative U.S. benchmark. Confirm this allowance and the actual shop or supplier rate." :
            "Uses the shop rate on file and preliminary operation allowances. Confirm the amounts before quoting.",
          overrideReason: "", baselineAmount: row.amount, baselineRate: row.rate,
          demo: settings.demo, reviewedRevisionId: revision, reviewRunId: null,
        },
      };
    })] as const;
  }));
  if (job.installation === "included") unpriced.add("Price installation, site access, equipment and travel.");
  else if (job.installation !== "excluded") unpriced.add("Confirm whether delivery or installation is included.");
  if (job.source_callouts?.some(row => row.status === "recovered" && row.part_id && !job.scope_decisions?.[row.part_id]))
    unpriced.add("Decide which additional drawing items are included in this quote.");
  return { ...draft, benchmark: {name, date, demo:settings.demo, unpriced:[...unpriced].slice(0,250)},
    items: draft.items.map(item => priced.has(item.id) ? {...item, costRows:priced.get(item.id)!} : item) };
}
