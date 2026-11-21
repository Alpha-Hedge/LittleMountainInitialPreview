import { getApprovalSnapshot, listApprovedVersions } from "./workflow";
import { getJob } from "./jobs";
import { listQuotes, listQuoteVersions } from "./quotes";
import type { LineItem } from "./types";
import type { Comparable } from "./job-types";
import { blueprintOrigin } from "./engineering-ledger";

export function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[×]/g, "x")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim();
}
function specLine(description: string, label: string) {
  return (
    description
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith(label + ":"))
      ?.split(":")
      .slice(1)
      .join(":")
      .trim() || ""
  );
}
export function lineSpecs(item: LineItem) {
  return {
    name: item.description.split("\n")[0],
    material: specLine(item.description, "material / grade") || specLine(item.description, "material"),
    dimensions: specLine(item.description, "dimensions"),
    units: specLine(item.description, "units"),
  };
}

/** Unranked projections of exact, approved quote versions. The same shape is published to Supabase. */
export function listLocalLearningCandidates(quoteId?: string): Comparable[] {
  const result: Comparable[] = [];
  const ids = quoteId ? [quoteId] : listQuotes().map((q) => q.id);
  for (const id of ids) {
    const versions = listApprovedVersions(id);
    if (!versions.length) continue;
    const drafts = listQuoteVersions(id).reverse(),
      first = drafts[0];
    if (!first) continue;
    const origin = blueprintOrigin(id);
    for (const version of versions) {
      const approved = getApprovalSnapshot(id, version)!;
      const priced = drafts.find((q) => q.version <= version && q.totals.sellingPrice > 0);
      const completed = getJob(id, version);
      for (const line of approved.quote.items) {
        const spec = lineSpecs(line);
        if (origin && origin.selectedRevision === (approved.drawing?.id ?? null)) {
          const engineering = origin.job.ast?.parts;
          const part = Array.isArray(engineering) ? engineering.find(p => p && typeof p === "object" && !Array.isArray(p) && p.part_id === line.id) : undefined;
          if (part && typeof part === "object" && !Array.isArray(part)) {
            spec.material ||= [part.material_family, part.material_grade].filter(Boolean).join(" ");
            const outline = part.outline;
            if (!spec.dimensions && outline && typeof outline === "object" && !Array.isArray(outline) && outline.width_in && outline.height_in) {
              spec.dimensions = [outline.width_in, outline.height_in, part.thickness_in].filter(Boolean).join(" x ");
              spec.units = "in";
            }
          }
        }
        const actuals = completed?.rows.filter((r) => r.itemId === line.id) || [];
        const decision = approved.details.pricingDecision;
        result.push({
          quoteId: id,
          version,
          number: approved.quote.number,
          jobName: approved.quote.jobName,
          lineId: line.id,
          description: spec.name,
          workType: line.costRows.find((r) => r.estimate)?.estimate?.workType || "",
          material: spec.material,
          dimensions: [spec.dimensions, spec.units].filter(Boolean).join(" "),
          quantity: line.quantity,
          operations: line.costRows.map((r) => ({
            label: r.label,
            kind: r.estimate?.category || "manual",
            amount: r.amount,
            unit: r.estimate?.unit || "",
            basis: r.basis,
          })),
          reasons: [],
          score: 0,
          completed: actuals.length > 0,
          actuals,
          completedEdit: completed?.edit,
          scopeChanges: completed?.scopeChanges || "",
          overrideReasons: [
            completed?.overrideReasons,
            ...line.costRows.filter(r => r.review?.disposition !== "one_time").map((r) => r.review?.reason || r.estimate?.overrideReason),
          ]
            .filter(Boolean)
            .join("\n"),
          pricing: {
            firstAvailableVersion: first.version,
            firstSellingPrice: first.totals.sellingPrice,
            firstMarginPercent: first.marginPercent,
            firstPricedVersion: priced?.version,
            firstPricedSellingPrice: priced?.totals.sellingPrice,
            firstPricedMarginPercent: priced?.marginPercent,
            approvedSellingPrice: approved.quote.totals.sellingPrice,
            approvedMarginPercent: approved.quote.marginPercent,
            approvedAt: approved.approvedAt,
            ...(decision ? { decision } : {}),
          },
        });
      }
    }
  }
  return result;
}

/** Return one representative line per job to keep revisions or multipart jobs from over-weighting a trend. */
export function findComparables(
  candidates: Comparable[],
  targetId: string,
  item: LineItem,
  workType: string,
  operations: string[],
  reviewed: { material?: string; dimensions?: string; units?: string },
): Comparable[] {
  const target = { ...lineSpecs(item), ...reviewed };
  const opNames = new Set(operations.map(normalize));
  const dimensionKey = (dimensions: string) => normalize(dimensions).replace(/ /g, "");
  const matches: Comparable[] = [];
  for (const record of candidates) {
    if (record.quoteId === targetId && !record.evidenceHref) continue;
    const reasons: string[] = [];
    let score = 0;
    if (record.workType && normalize(workType) === normalize(record.workType)) {
      score += 4;
      reasons.push("Same work type");
    }
    if (record.material && normalize(target.material) === normalize(record.material)) {
      score += 4;
      reasons.push("Same material or grade");
    }
    if (
      record.dimensions &&
      dimensionKey(target.dimensions + " " + target.units) === dimensionKey(record.dimensions)
    ) {
      score += 3;
      reasons.push("Matching dimensions and units");
    }
    if (record.description && normalize(target.name) === normalize(record.description)) {
      score += 2;
      reasons.push("Same part description");
    }
    const shared = record.operations.filter((o) => opNames.has(normalize(o.label)));
    if (shared.length) {
      score += Math.min(3, shared.length);
      reasons.push("Shared operations: " + shared.map((o) => o.label).join(", "));
    }
    if (!score) continue;
    const ratio = Math.max(record.quantity, item.quantity) / Math.min(record.quantity, item.quantity);
    if (ratio <= 2) {
      score += ratio === 1 ? 2 : 1;
      reasons.push(ratio === 1 ? "Same quantity" : "Quantity within a factor of two");
    }
    matches.push({ ...record, reasons, score });
  }
  const sorted = matches.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.completed) - Number(a.completed) ||
      (b.pricing?.approvedAt || "").localeCompare(a.pricing?.approvedAt || "") ||
      b.version - a.version ||
      a.quoteId.localeCompare(b.quoteId) ||
      a.lineId.localeCompare(b.lineId),
  );
  // Reserve space for completed work so a run of newer uncompleted quotes cannot bury measured evidence.
  const selected = new Map<string, Comparable>();
  function include(record: Comparable) {
    const key = JSON.stringify([record.sourceWorkspace || "", record.quoteId]);
    if (!selected.has(key)) selected.set(key, record);
  }
  for (const record of sorted) {
    if (
      record.actuals.some(
        (a) =>
          !a.exceptionReason?.trim() &&
          a.unit === "h" &&
          (opNames.has(normalize(a.operation)) ||
            record.operations.some((o) => o.kind === a.kind && opNames.has(normalize(o.label)))),
      )
    )
      include(record);
    if (selected.size >= 5) break;
  }
  for (const record of sorted) {
    include(record);
    if (selected.size >= 8) break;
  }
  const retained = new Set(selected.values());
  return sorted.filter((r) => retained.has(r));
}
