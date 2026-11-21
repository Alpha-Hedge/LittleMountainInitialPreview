import { isTime, type Comparable } from "./job-types";
import type { CostRow } from "./types";

export interface MeasuredAllowance {
  operationId: string;
  label: string;
  templateHours: number;
  observedHours: number;
  basis: string;
  calculation: string;
  samples: { ref: string; hours: number; total: number; quantity: number }[];
  recurring: boolean;
}
const opName = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const rounded = (n: number) => Number(n.toFixed(4));
export function compareAllowances(rows: CostRow[], records: Comparable[]): MeasuredAllowance[] {
  return rows.flatMap((row) => {
    const meta = row.estimate;
    if (!meta || !isTime(meta.category) || !/^(h|hr|hrs|hours?)$/i.test(meta.unit)) return [];
    const samples: MeasuredAllowance["samples"] = [];
    const matchedJobs = new Set<string>();
    for (const [index, r] of records.entries()) {
      if (!r.completed || r.quantity <= 0) continue;
      const job = JSON.stringify([r.sourceWorkspace || "", r.quoteId]);
      if (matchedJobs.has(job)) continue;
      const category = r.actuals.filter((a) => a.kind === meta.category && a.unit === "h");
      let match = category.filter((a) => opName(a.operation) === opName(row.label));
      // A single historical and target setup can be matched even when Nick used a shorter closeout label.
      if (!match.length && rows.filter((s) => s.estimate?.category === meta.category).length === 1) {
        const historic = r.operations.filter((s) => s.kind === meta.category);
        if (
          historic.length === 1 &&
          opName(historic[0].label) === opName(row.label) &&
          new Set(category.map((a) => opName(a.operation))).size === 1
        )
          match = category;
      }
      const ordinary = match.filter((a) => !a.exceptionReason?.trim());
      if (!ordinary.length) continue;
      matchedJobs.add(job);
      const total = rounded(ordinary.reduce((sum, a) => sum + a.amount, 0));
      samples.push({
        ref: "R" + (index + 1),
        hours: rounded(total / (row.basis === "batch" ? 1 : r.quantity)),
        quantity: r.quantity,
        total,
      });
    }
    if (!samples.length) return [];
    const sorted = samples.map((s) => s.hours).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const observedHours =
      sorted.length % 2 ? sorted[middle] : rounded((sorted[middle - 1] + sorted[middle]) / 2);
    const unitBasis = row.basis === "batch" ? "batch" : "part";
    const first = samples[0];
    const calculation =
      samples.length === 1
        ? first.ref +
          " recorded " +
          first.total +
          " h for " +
          first.quantity +
          " parts. " +
          observedHours +
          " h per " +
          unitBasis +
          "."
        : "Across " +
          samples.length +
          " completed jobs, the median was " +
          observedHours +
          " h per " +
          unitBasis +
          " (template " +
          row.amount +
          " h).";
    const sameDirection =
      samples.every((s) => s.hours > row.amount) || samples.every((s) => s.hours < row.amount);
    return [
      {
        operationId: meta.operationId,
        label: row.label,
        templateHours: row.amount,
        observedHours,
        basis: row.basis,
        calculation,
        samples,
        recurring:
          samples.length >= 5 &&
          sameDirection &&
          meta.driver === "fixed" &&
          samples.every((s) => {
            const r = records[Number(s.ref.slice(1)) - 1];
            return r.reasons.includes("Same work type") || r.reasons.includes("Same part description");
          }),
      },
    ];
  });
}
