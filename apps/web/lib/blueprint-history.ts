import { readLearningCandidates } from "./cloud-history";

export async function blueprintLearningContext() {
  try {
    const candidates = await readLearningCandidates();
    return {
      hosted_history_status: candidates === null ? "local" : "supabase",
      hosted_history: (candidates ?? [])
        .filter(c => c.sourceWorkspace && c.pricing?.approvedAt && c.material && c.quantity >= 1)
        .sort((a, b) => (b.pricing?.approvedAt || "").localeCompare(a.pricing?.approvedAt || ""))
        .slice(0, 200)
        .map(c => ({
          workspace: c.sourceWorkspace, quote_id: c.quoteId.slice(0,120), revision: c.version,
          line_id: c.lineId.slice(0,120), number: c.number.slice(0,120), description: c.description.slice(0,500),
          material: c.material.slice(0,200), dimensions: c.dimensions.slice(0,200),
          work: [c.workType, ...c.operations.map(x => x.label), ...c.actuals.map(x => x.operation)].filter(Boolean).slice(0,25).map(s => s.slice(0,180)),
          actuals: c.actuals.slice(0,16).map(x =>
            (x.operation + " " + x.amount + " " + x.unit + (x.exceptionReason ? " · " + x.exceptionReason : "")).slice(0,220)
          ),
          quantity: c.quantity, approved_at: c.pricing!.approvedAt,
          completed_edit: c.completedEdit ?? null, scope_changes: (c.scopeChanges ||
            c.actuals.find(x => x.exceptionReason)?.exceptionReason || "").slice(0,400),
          override_reason: (c.pricing?.decision?.reason || c.overrideReasons).slice(0,400),
          decision: c.pricing?.decision?.kind ?? "standard",
        })),
    };
  } catch {
    return { hosted_history_status: "unavailable", hosted_history: [] };
  }
}
