import { createHash } from "node:crypto";
import type { BlueprintJob, BlueprintLine, BlueprintObject, BlueprintRow, BlueprintValue } from "./blueprint-types";
import { uploadDrawing } from "./drawings";
import { blueprintOrigin, engineeringDb, recordBlueprintProposals } from "./engineering-ledger";
import { calculateQuote, createQuote, getQuote, QuoteError } from "./quotes";
import type { CostRow, Quote, QuoteDraft, RowEstimate } from "./types";
import { drawingDraftPart, drawingDraftPartId } from "./quote-start";
import { fillBenchmark } from "./benchmark";
import type { EstimatingSettings } from "./estimating-types";
import { quoteQuantity } from "./blueprint-review-evidence";

function deskNumber(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new QuoteError("Invalid engineering pricing input.", 422);
  return Number(number.toFixed(4));
}

function deskRow(job: BlueprintJob, line: BlueprintLine, row: BlueprintRow, extended: boolean): CostRow {
  const rate = deskNumber(extended ? row.cost_usd : row.rate);
  const amount = extended ? 1 : deskNumber(row.amount);
  const basis = extended ? "batch" : row.basis;
  const category = row.stage === "setup" ? "setup" : ({
    cut:"machine", bend:"machine", weld:"labor", filler:"material", gas:"material", material:"material",
  } as Record<string, RowEstimate["category"]>)[row.category] ?? "outside";
  const physicalUnit = row.work_center ? "hours" : row.category === "filler" ? "lb" :
    row.category === "gas" ? "scf" : row.category === "material" ? "stock allocation" : "allowance";
  const basisText = [row.basis_text, row.citations.join(". "), ...(row.rule_citations ?? []).map(c => c.excerpt)].filter(Boolean).join(" ");
  const estimate: RowEstimate = {
    category, unit: extended ? "batch charge" : row.unit ?? physicalUnit,
    includes: row.includes ?? row.label, minimumCost: 0, settingsVersion: job.version,
    ...(row.rate_source && row.rate_effective_on ? {
      rateSource:row.rate_source.slice(0,500), rateEffectiveOn:row.rate_effective_on, rateSettingsVersion:job.version,
    } : {}),
    rateId: row.id, templateId: job.id, templateName: String(job.settings.snapshot_name || "Engineering rate card"),
    operationId: row.id, workType: line.processes.join(" / "), driver: "fixed", coefficient: 1,
    rationale: basisText.slice(0,8000) || row.label,
    assumption: `Engineering basis: ${row.amount} × $${row.rate} (${row.basis}).`,
    overrideReason: "", baselineAmount: amount, baselineRate: rate, demo: job.settings.demo === true,
    reviewedRevisionId: null, reviewRunId: null,
  };
  return { id:row.id, label:row.label, amount, rate, basis, estimate,bufferMaterial:row.category==="material" };
}

function draftFor(job: BlueprintJob): QuoteDraft {
  const result = job.result!;
  const parts = Array.isArray(job.ast?.parts) ? job.ast.parts.filter(isRecord) : [];
  const requirements = parts.flatMap(part => Array.isArray(part.requirements) && part.requirements.length
    ? [String(part.description || part.part_id) + " · " + part.requirements.filter(value => typeof value === "string").join("; ")]
    : []);
  const draft: QuoteDraft = {
    customer:job.customer_name, jobName:job.job_name,
    notes:[job.notes,shopDecisions(job),requirements.length ? "Shop requirements from the drawing\n" + requirements.join("\n") : ""].filter(Boolean).join("\n\n").slice(0,50000),
    marginPercent:Number(result.totals.gross_margin_pct),
    items:result.lines.map(line => {
      const part = parts.find(part => part.part_id === line.part_id);
      return {id:line.part_id, description:[line.description, part?.finish && "Finish: " + part.finish].filter(Boolean).join("\n"),
        quantity:line.quantity, costRows:line.rows.map(row => deskRow(job, line, row, false))};
    }),
  };
  // The desk stores four decimal places. Retain working hours whenever they reproduce
  // the billed cents. Otherwise use the extended charge and preserve the physical inputs.
  const priced = calculateQuote(draft);
  result.lines.forEach((line, i) => {
    line.rows.forEach((row, j) => {
      if (priced.items[i].rows[j].cost !== Number(row.cost_usd))
        draft.items[i].costRows[j] = deskRow(job,line,row,true);
    });
  });
  return draft;
}

export function createBlueprintDraft(job: BlueprintJob, sourcePDF?: Buffer, manual = false, budget: boolean | EstimatingSettings = false): Quote {
  const db = engineeringDb();
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT create_blueprint" : "BEGIN IMMEDIATE");
  try {
    const prior = db.prepare("SELECT quote_id FROM engineering_blueprint_drafts WHERE job_id=? AND job_version=?").get(job.id,job.version);
    let q: Quote;
    if (prior) q = getQuote(String(prior.quote_id))!;
    else {
      if (manual ? job.state !== "review_required" || !job.ast : job.state !== "ready" || !job.result?.lines.length)
        throw new QuoteError("Finish the drawing review and estimate before creating a quote.", 409);
      if (sourcePDF && (sourcePDF.subarray(0,5).toString() !== "%PDF-" ||
          createHash("sha256").update(sourcePDF).digest("hex") !== job.drawing.sha256))
        throw new QuoteError("The drawing file does not match the estimated revision.",409);
      const draft = manual ? preparedDraft(job) : draftFor(job);
      q = createQuote(manual && budget ? fillBenchmark(draft, job, null, budget === true ? undefined : budget) : draft);
      const estimate = manual ? null : job.result;
      if (estimate && (q.totals.sellingPrice !== Number(estimate.totals.selling_price_usd) ||
          q.totals.estimatedCost !== Number(estimate.totals.estimated_cost_usd) ||
          estimate.lines.some((line,i) => q.totals.items[i].cost !== Number(line.estimated_cost_usd) ||
            line.rows.some((row,j) => q.totals.items[i].rows[j].cost !== Number(row.cost_usd))))
          )
        throw new QuoteError("The drawing estimate and desk amounts differ. Review the rate card before continuing.",422);
      const local = sourcePDF ? uploadDrawing(q.id,{bytes:sourcePDF,fileName:job.drawing.filename},"", String(job.drawing.revision)).selectedRevisionId : null;
      db.prepare("INSERT INTO engineering_blueprint_drafts VALUES(?,?,?,?,?)")
        .run(job.id,job.version,q.id,local,JSON.stringify(job));
      if (!manual) recordBlueprintProposals(db, q, job);
    }
    db.exec(nested ? "RELEASE create_blueprint" : "COMMIT");
    return q;
  } catch (error) {
    db.exec(nested ? "ROLLBACK TO create_blueprint; RELEASE create_blueprint" : "ROLLBACK");
    throw error;
  }
}

function isRecord(value: BlueprintValue): value is BlueprintObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shopDecisions(job: BlueprintJob) {
  const excluded = (job.source_callouts || []).filter(row => row.part_id && job.scope_decisions?.[row.part_id] === "exclude");
  const open = (job.source_callouts || []).filter(row => row.status === "recovered" && row.part_id && !job.scope_decisions?.[row.part_id]);
  return [job.shop_scope && "Shop scope: " + job.shop_scope,
    job.installation && job.installation !== "confirm" && "Installation: " + job.installation,
    excluded.length ? "Outside shop scope: " + excluded.map(row => row.label).join("; ") : "",
    open.length ? "Scope open (held out of budget): " + open.map(row => row.label).join("; ") : "",
  ].filter(Boolean).join("\n");
}

function preparedDraft(job: BlueprintJob): QuoteDraft {
  const raw = job.ast?.parts;
  const parts = Array.isArray(raw) ? raw.filter(isRecord) : [];
  const needsQuantity: string[] = [];
  const scope: string[] = [];
  const items: QuoteDraft["items"] = [];
  for (const [index, part] of parts.entries()) {
    if (job.scope_decisions?.[String(part.part_id)] === "exclude") continue;
    const name = String(part.description || part.part_id || "Part " + (index + 1));
    if (job.source_callouts?.some(row => row.status === "recovered" && row.part_id === part.part_id)
        && job.scope_decisions?.[String(part.part_id)] !== "include") continue;
    const stock = [part.material_family,part.material_grade,part.section_designation].filter(Boolean).join(" ");
    const measured = isRecord(part.outline) && part.outline.width_in && part.outline.height_in ?
      part.outline.width_in + " × " + part.outline.height_in + " in" : "";
    const drills = Array.isArray(part.holes) ? part.holes.filter(hole=>isRecord(hole)&&hole.cutting_method==="drill").length : 0;
    const field = Array.isArray(part.welds) && part.welds.some(w=>isRecord(w)&&w.field_weld===true);
    const tasks = [stock && "confirm stock and supplier rate", part.section_designation && "confirm cuts and lengths",
      drills>0 && "check " + drills + (drills===1 ? " drilled opening" : " drilled openings"),
      Array.isArray(part.welds) && part.welds.length>0 && (field ? "confirm site weld and access" : "confirm joining and fit-up"),
      part.finish && "confirm " + part.finish].filter(Boolean);
    const written = Array.isArray(part.requirements) ? part.requirements.filter(value => typeof value === "string") : [];
    scope.push(name + (tasks.length ? " · " + tasks.join(", ") : " · confirm operations and time") +
      (written.length ? "\n  Drawing notes: " + written.join("; ") : ""));
    const quantity = quoteQuantity(job,part,index);
    if (quantity === null) needsQuantity.push(name);
    items.push({id:String(part.part_id || "source-part-"+index),quantity:quantity ?? 1,
      ...(quantity === null ? { quantityPending: true } : {}),
      description:[name,stock&&"Material / grade: "+stock, measured&&"Dimensions: "+measured,
        part.thickness_in ? "Thickness: "+part.thickness_in+" in" : "",
        typeof part.finish === "string" && !job.flags?.some(flag => flag.path === `parts.${index}.finish`) ? "Finish: "+part.finish : ""]
        .filter(Boolean).join("\n").slice(0,16000),costRows:[]});
  }
  if (!items.length) items.push({ id:drawingDraftPartId,description:drawingDraftPart,quantity:1,costRows:[] });
  const notes = [job.notes,shopDecisions(job),scope.length ? "Drawing scope to check\n"+scope.join("\n") : "",
    needsQuantity.length ? "Enter ordered quantities for: "+needsQuantity.join(", ") : ""].filter(Boolean).join("\n\n");
  return {customer:job.customer_name,jobName:job.job_name,notes:notes.slice(0,50000),
    marginPercent:Number(job.settings.gross_margin_pct),items};
}

export function checkBlueprintInputs(q: Quote, selectedRevision: string|null) {
  const source = blueprintOrigin(q.id);
  if (source && !source.job.result && !q.benchmark?.takeoff && q.items.some(item => !item.costRows.length))
    throw new QuoteError("Enter a confirmed cost for each manually estimated line before approval.", 409);
  if (!source?.job.result) return;
  const original = source.job.result.lines;
  const current = new Map(q.items.map(item => [item.id,item]));
  // Stock and setups can be shared across items. Removing another nested part or changing
  // its quantity invalidates the remaining allocation even if that part has no rows left.
  const retainsCharges = original.some(line => {
    const ids = new Set(line.rows.map(row => row.id));
    return current.get(line.part_id)?.costRows.some(r => ids.has(r.id));
  });
  if (!retainsCharges) return;
  if (source.selectedRevision !== selectedRevision || original.some(line => current.get(line.part_id)?.quantity !== line.quantity))
    throw new QuoteError("The drawing or batch quantity has changed. Recalculate from the revised blueprint or replace the imported cost rows before approving.",409);
}
