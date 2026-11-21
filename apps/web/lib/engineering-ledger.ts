import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import type { HistoryRun } from "./history-types";
import type { LineItem, Quote } from "./types";
import type { CustomerQuote, ReviewSnapshot } from "./workflow-types";
import { savedRouting } from "./work-center-routing";
import type { BlueprintJob, BlueprintLine, BlueprintValue, BlueprintRow } from "./blueprint-types";
import { calculateQuote } from "./quotes";

type Citation = { kind: "historical_job" | "template" | "drawing" | "nick_rule"; reference: string; excerpt: string };
interface Proposal {
  suggested?: BlueprintRow;
  initial?: { rate:number; basis:"batch"|"per_unit"; minimum:number };
  rowId: string; operationId: string; runId: string; model: string; hours: number | null;
  basis: string; assumption: string; confidence: number | null; citations: Citation[];
}

export function engineeringDb() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_proposals (
    quote_id TEXT NOT NULL, item_id TEXT NOT NULL, row_id TEXT NOT NULL, version INTEGER NOT NULL,
    proposal TEXT NOT NULL, PRIMARY KEY(quote_id,item_id,row_id,version)
  );
  CREATE TABLE IF NOT EXISTS engineering_reviewed_runs (run_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS engineering_blueprint_drafts (
    job_id TEXT NOT NULL, job_version INTEGER NOT NULL, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
    selected_local_revision TEXT, payload TEXT NOT NULL, PRIMARY KEY(job_id, job_version)
  );
  CREATE TABLE IF NOT EXISTS engineering_approvals (
    quote_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL,
    receipt TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    PRIMARY KEY(quote_id,version)
  );
  CREATE VIEW IF NOT EXISTS engineering_quote_line_versions AS
  SELECT v.id AS quote_id, v.version, json_extract(i.value,'$.id') AS line_id, i.value AS entered,
    (SELECT CASE WHEN count(*)>0 THEN json_group_array(json(p.proposal)) END FROM engineering_proposals p
       JOIN json_each(i.value,'$.costRows') c ON json_extract(c.value,'$.id')=p.row_id
       WHERE p.quote_id=v.id AND p.item_id=json_extract(i.value,'$.id') AND p.version<=v.version) AS ai_proposed,
    json_extract(approved.value,'$.nick_approved') AS nick_approved,
    (SELECT CASE WHEN count(*)=count(json_extract(p.proposal,'$.confidence')) THEN min(json_extract(p.proposal,'$.confidence')) END
       FROM engineering_proposals p JOIN json_each(i.value,'$.costRows') c ON json_extract(c.value,'$.id')=p.row_id
       WHERE p.quote_id=v.id AND p.item_id=json_extract(i.value,'$.id') AND p.version<=v.version) AS confidence_score,
    COALESCE(json_extract(approved.value,'$.citations'),
      (SELECT json_group_array(json(citation.value)) FROM engineering_proposals p
       JOIN json_each(i.value,'$.costRows') c ON json_extract(c.value,'$.id')=p.row_id
       JOIN json_each(p.proposal,'$.citations') citation
       WHERE p.quote_id=v.id AND p.item_id=json_extract(i.value,'$.id') AND p.version<=v.version)) AS citations
    FROM quote_versions v JOIN json_each(v.draft,'$.items') i
    LEFT JOIN engineering_approvals a ON v.id=a.quote_id AND v.version=a.version
    LEFT JOIN json_each(a.payload,'$.lines') approved ON json_extract(approved.value,'$.line_key')=json_extract(i.value,'$.id');`);
  return db;
}

export function blueprintOrigin(quoteId: string) {
  const row = engineeringDb().prepare("SELECT selected_local_revision,payload FROM engineering_blueprint_drafts WHERE quote_id=?").get(quoteId);
  return row ? { job: JSON.parse(String(row.payload)) as BlueprintJob,
    selectedRevision: row.selected_local_revision == null ? null : String(row.selected_local_revision) } : null;
}

function objectValue(value: BlueprintValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function drawingConfidence(job: BlueprintJob, line: BlueprintLine) {
  const parts = job.original_ast?.parts;
  if (!Array.isArray(parts)) return null;
  const part = objectValue(parts.find(p => objectValue(p)?.part_id === line.part_id));
  if (!part) return null;
  const nodes = [part, objectValue(part.outline), ...["holes","bends","welds"].flatMap(key => {
    const list = part[key];
    return Array.isArray(list) ? list.map(objectValue) : [];
  })];
  const scores = nodes.map(node => node?.confidence).filter((n): n is number => typeof n === "number");
  return scores.length ? Math.min(...scores) : null;
}

export function recordBlueprintProposals(db: DatabaseSync, q: Quote, job: BlueprintJob) {
  const write = db.prepare("INSERT INTO engineering_proposals VALUES(?,?,?,?,?)");
  for (const line of job.result!.lines) {
    const confidence = drawingConfidence(job, line);
    for (const row of line.rows) {
      const proposal = {
        rowId:row.id, operationId:row.id, runId:job.id, model:job.model ?? "reviewed drawing",
        hours:row.work_center ? Number(row.amount) : null, basis:row.basis_text,
        assumption:"Deterministic shop calculation using the reviewed drawing.", confidence,
        citations: [
          {kind:"drawing", reference:job.drawing.id, excerpt:job.drawing.filename + " revision " + job.drawing.revision},
          ...row.citations.map(excerpt => ({kind:"template",reference:job.id+"/v"+job.version+"/"+excerpt,excerpt})),
          ...line.history.map(match => match.citation), ...(row.rule_citations ?? []), ...line.rules,
        ],
        suggested:row, baseline:line.baseline_rows.find(r => r.id === row.id) ?? row,
      };
      write.run(q.id,line.part_id,row.id,q.version,JSON.stringify(proposal));
    }
  }
}

export function recordModelProposals(db: DatabaseSync, run: HistoryRun, item: LineItem, version: number) {
  const insert = db.prepare("INSERT OR IGNORE INTO engineering_proposals VALUES(?,?,?,?,?)");
  for (const row of item.costRows) {
    const meta = row.estimate;
    if (!meta || meta.templateId !== run.templateId) continue;
    const advice = run.advice.find(a => a.operationId === meta.operationId);
    if (!advice) continue;
    const citations: Citation[] = [{ kind: "template", reference: meta.templateId + "/v" + meta.settingsVersion, excerpt: meta.rationale }];
    for (const ref of advice.sources) {
      const job = run.records[Number(ref.slice(1)) - 1];
      if (job) citations.push({ kind: "historical_job",
        reference: [job.sourceWorkspace ?? "local", job.quoteId, job.version, job.lineId, job.completedEdit ?? ""].join("/"),
        excerpt: job.number + " v" + job.version + " · " + job.description });
    }
    const baseline = run.base?.rows?.find(r => r.estimate?.operationId === meta.operationId) ?? row;
    const proposal: Proposal = { rowId: row.id, operationId: meta.operationId, runId: run.id, model: run.model,
      hours: advice.hours, confidence: advice.confidence ?? null, basis: advice.basis, assumption: advice.assumption, citations,
      initial: {rate:baseline.rate, basis:baseline.basis, minimum:baseline.estimate?.minimumCost ?? 0} };
    insert.run(run.quoteId, item.id, row.id, version, JSON.stringify(proposal));
  }
  db.prepare("INSERT OR IGNORE INTO engineering_reviewed_runs VALUES(?)").run(run.id);
}

function existingProposals(db: DatabaseSync, q: Quote) {
  // Earlier releases already retained exact raw runs and the version on which staff applied them.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='history_estimates'").get()) {
    const missing = db.prepare(`SELECT h.body,h.applied_version,v.draft FROM history_estimates h
      JOIN quote_versions v ON v.id=h.quote_id AND v.version=h.applied_version
      LEFT JOIN engineering_reviewed_runs e ON e.run_id=h.id
      WHERE h.quote_id=? AND h.applied_version<=? AND e.run_id IS NULL`).all(q.id, q.version);
    for (const row of missing) {
      const run = JSON.parse(String(row.body)) as HistoryRun;
      const item = (JSON.parse(String(row.draft)).items as LineItem[]).find(i => i.id === run.itemId);
      if (item) recordModelProposals(db, run, item, Number(row.applied_version));
    }
  }
  return db.prepare("SELECT item_id,row_id,proposal FROM engineering_proposals WHERE quote_id=? AND version<=? ORDER BY version").all(q.id, q.version);
}

export function reviewOperations(q: Quote, proposals = existingProposals(engineeringDb(),q)) {
  const rows = q.items.flatMap((item, i) => item.costRows.map((row,j) => {
    const original = proposals.findLast(p=>p.item_id===item.id && p.row_id===row.id);
    const ai: Proposal | undefined = original && JSON.parse(String(original.proposal));
    const source = ai?.suggested;
    const physical = !!source && row.estimate?.unit==="batch charge";
    const unit = physical ? source.unit || (source.work_center ? "hours" : "units") : row.estimate?.unit || "";
    const hourly = !!source?.work_center || ai?.hours != null || /\b(h|hr|hrs|hours?)\b/i.test(unit+" "+row.label);
    const multiplier = (basis:string) => basis==="per_unit" ? item.quantity : 1;
    const basis = physical ? source.basis : row.basis;
    const amount = physical ? Number(source.amount) : row.amount;
    const proposedAmount = source ? Number(source.amount) : ai?.hours ?? null;
    const proposedBasis = source?.basis ?? ai?.initial?.basis ?? row.basis;
    const proposedRate = source ? Number(source.rate) : ai?.initial?.rate ?? row.estimate?.baselineRate ?? row.rate;
    const match=(row.label+" "+(row.estimate?.workType||"")).toLowerCase();
    const category=source?.category || (row.estimate?.category==="material" ? "material" : /weld|tig|mig/.test(match) ? "weld" : /bend|brake/.test(match) ? "bend" : /cut|laser|plasma|saw/.test(match) ? "cut" : "other");
    return {itemId:item.id,rowId:row.id,center:source ? source.work_center || "" : row.label,category,
      stage:source?.stage || (category==="material"?"stock":row.estimate?.category==="setup"?"setup":"run"),
      unit,hourly,basis,amount,physical,proposedAmount,proposedBasis,proposedRate,
      aiHours:hourly && proposedAmount!==null ? proposedAmount*multiplier(proposedBasis) : null,
      nickHours:hourly ? amount*multiplier(basis) : null, aiCost:source ? Number(source.cost_usd) : null as number|null,
      nickCost:q.totals.items[i].rows[j].cost, reason:row.review?.reason || row.estimate?.overrideReason || "",
      disposition:row.review?.disposition || (/^Quote-only exception:/i.test(row.estimate?.overrideReason || "")?"one_time":"standard"),citations:ai?.citations || [], explanation:ai?.basis || row.estimate?.rationale || "",
      originalMinimum:ai?.initial?.minimum ?? row.estimate?.minimumCost ?? 0};
  }));
  const missing=rows.filter(r=>r.aiCost===null && r.proposedAmount!==null);
  if(missing.length){
    const costs=calculateQuote({...q,marginPercent:0,scrapBufferPct:0,items:q.items.map(item=>({...item,
      costRows:item.costRows.map(row=>{
        const op=missing.find(r=>r.itemId===item.id && r.rowId===row.id);
        return op ? {...row,amount:op.proposedAmount,rate:op.proposedRate,basis:op.proposedBasis,review:undefined,
          estimate:row.estimate && {...row.estimate,minimumCost:op.originalMinimum}} : row;
      })}))});
    for(const op of missing) op.aiCost=costs.items.find(i=>i.id===op.itemId)!.rows.find(r=>r.id===op.rowId)!.cost;
  }
  return rows;
}
export type ReviewOperation = ReturnType<typeof reviewOperations>[number];

export function engineeringLines(snapshot: ReviewSnapshot, approved?: CustomerQuote) {
  const q = snapshot.quote;
  const db = engineeringDb();
  const proposals = existingProposals(db, q);
  const operations = reviewOperations(q,proposals);
  const origin = blueprintOrigin(q.id);
  return q.items.map((item, index) => {
    const sources = new Map<string, Citation>();
    const add = (c: Citation) => sources.set(c.kind + ":" + c.reference, c);
    const advice: Proposal[] = [];
    for (const row of item.costRows) {
      const found = proposals.findLast(p => p.item_id === item.id && p.row_id === row.id);
      if (found) {
        const proposal = JSON.parse(String(found.proposal)) as Proposal;
        advice.push(proposal);
        for (const citation of proposal.citations) add(citation);
      }
      const e = row.estimate;
      if (e) add({ kind: "template", reference: e.templateId + "/v" + e.settingsVersion, excerpt: e.templateName });
    }
    if (snapshot.drawing) add({ kind:"drawing", reference:snapshot.drawing.id, excerpt:snapshot.drawing.fileName });
    const scores = advice.flatMap(p => p.confidence === null ? [] : [p.confidence]);
    const generated = origin?.job.result?.lines.find(l => l.part_id === item.id);
    const originalIds = new Set(generated?.rows.map(r => r.id));
    const sameFeatures = generated && generated.quantity === item.quantity &&
      (snapshot.drawing?.id ?? null) === origin?.selectedRevision && item.costRows.some(r => originalIds.has(r.id));
    const parts = origin?.job.ast?.parts;
    const part = Array.isArray(parts) ? objectValue(parts.find(p=>objectValue(p)?.part_id===item.id)) : null;
    const entered = { costRows: item.costRows, quantity: item.quantity, estimatedCost: q.totals.items[index].cost,
      review_operations:operations.filter(r=>r.itemId===item.id), scrapBufferPct:q.scrapBufferPct??0, scrapCost:q.totals.items[index].scrapCost??0,
      routing: savedRouting(q.id, item.id, q.version), ...(sameFeatures && {
retrieval:{material_family:generated.material_family, thickness_in:part?.thickness_in, weight_lb:generated.weight_lb, processes:generated.processes},
      }) };
    const citations = Array.from(sources.values());
    return { line_key:item.id, description:item.description, quantity:item.quantity, entered,
      ai_proposed:generated ? { operations:advice, blueprint:{part_id:generated.part_id, quantity:generated.quantity,
        rows:generated.rows, estimated_cost_usd:generated.estimated_cost_usd, selling_price_usd:generated.selling_price_usd} }
        : advice.length ? { operations:advice } : null,
      nick_approved:approved ? { ...entered, sellingPrice: approved.lines[index].sellingPrice, description:approved.lines[index].description } : null,
      confidence_score:scores.length === advice.length && scores.length ? Math.min(...scores) : null,
      citations, basis:advice.length ? "Model proposals and template sources are recorded by operation. Line confidence is the lowest reported operation score."
        : "Entered shop costs and any selected template rates are saved with the line.",
override_reason:[...item.costRows.map(r=>r.review?.reason || r.estimate?.overrideReason), snapshot.details.pricingDecision?.reason]
        .filter(Boolean).join("\n").slice(0,10000) };
  });
}

export function freezeEngineeringApproval(snapshot: ReviewSnapshot, customer: CustomerQuote, approvedAt: string) {
  const q = snapshot.quote;
  const origin = blueprintOrigin(q.id);
  const usesSource = origin && (snapshot.drawing?.id ?? null) === origin.selectedRevision;
  const payload = { quote_number:q.number, revision:q.version, customer_name:q.customer, job_name:q.jobName,
    status:"approved", gross_margin_pct:q.marginPercent, lines:engineeringLines(snapshot, customer),
    ...(usesSource && { drawing_id:origin.job.drawing.id }),
    pricing_inputs:{ policy:"USD-extended-row-half-up-v1", quoteId:q.id, approvedAt, approvedBy:"Nick",
      notes:q.notes, drawing:snapshot.drawing, reviews:snapshot.reviewRuns, details:snapshot.details, totals:q.totals, customer,
      ...(origin && { blueprint:origin.job }) } };
  engineeringDb().prepare("INSERT OR IGNORE INTO engineering_approvals(quote_id,version,payload) VALUES(?,?,?)")
    .run(q.id, q.version, JSON.stringify(payload));
}
