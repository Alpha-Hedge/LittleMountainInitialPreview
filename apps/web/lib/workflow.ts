import { runPricing } from "./python-engine";
import { savedRouting } from "./work-center-routing";
import { blueprintOrigin, freezeEngineeringApproval } from "./engineering-ledger";
import { checkBlueprintInputs } from "./blueprint-draft";
import { issueInternalCostSheet } from "./internal-cost-sheet";
import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db";
import { getQuote, getQuoteVersion, listQuoteVersions, QuoteError, updateQuote } from "./quotes";
import { getDrawingState } from "./drawings";
import { listReviews } from "./reviews";
import { drawingDraftCustomer, isDrawingDraftPart } from "./quote-start";
import { fieldKeys, fieldLabels, type ReviewRun } from "./review-types";
import { renderCustomerPdf } from "./customer-pdf";
import type { Quote } from "./types";
import { statusLabels, type ApprovalSnapshot, type CustomerQuote, type QuoteReviewView,
  type QuoteStatus, type ReviewDetails, type ReviewSnapshot } from "./workflow-types";
import { pricingDecisionLabels, type PricingDecision } from "./workflow-types";
export type { ApprovalSnapshot, CustomerQuote, QuoteStatus } from "./workflow-types";

const ready = new WeakSet<DatabaseSync>();
const drawingTriggers = new WeakSet<DatabaseSync>();
const commercialDate = (at = new Date()) => new Intl.DateTimeFormat("en-CA",{
  timeZone:"America/New_York", year:"numeric", month:"2-digit", day:"2-digit",
}).format(at);
function storage() {
  const db=getDb();
  if(!ready.has(db)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quote_workflow (
        quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
        status TEXT NOT NULL, snapshot TEXT NOT NULL, approved_at TEXT,
        customer_json TEXT, customer_pdf BLOB, expires_on TEXT NOT NULL,
        PRIMARY KEY (quote_id,version)
      );
      CREATE TABLE IF NOT EXISTS quote_events (
        id INTEGER PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
        kind TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_by_quote ON quote_events(quote_id,id);
      CREATE TRIGGER IF NOT EXISTS log_quote_revision AFTER UPDATE OF version ON quotes
      WHEN NEW.version != OLD.version BEGIN
        INSERT INTO quote_events(quote_id,version,kind,message,at)
          VALUES(NEW.id,NEW.version,'revision','Saved a new quote version',NEW.updated_at);
      END;
    `);
    if(!db.isTransaction) ready.add(db);
  }
  return db;
}
function watchDrawingChanges(db:DatabaseSync) {
  if(drawingTriggers.has(db)) return;
  // Selection and invalidation happen in a single SQL statement, including email imports.
  const revision = `
    UPDATE quotes SET version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=NEW.quote_id AND EXISTS(SELECT 1 FROM quote_workflow w WHERE w.quote_id=quotes.id AND w.version=quotes.version);
  `;
  db.exec(`CREATE TRIGGER IF NOT EXISTS revise_selected_drawing AFTER UPDATE OF revision_id ON drawing_selections
      WHEN OLD.revision_id != NEW.revision_id BEGIN ${revision} END;
    CREATE TRIGGER IF NOT EXISTS revise_first_drawing AFTER INSERT ON drawing_selections BEGIN ${revision} END;`);
  if(!db.isTransaction) drawingTriggers.add(db);
}
function atomic<T>(db:DatabaseSync,operation:()=>T) {
  db.exec("SAVEPOINT workflow_change");
  try {const output=operation();db.exec("RELEASE workflow_change");return output;}
  catch(e){db.exec("ROLLBACK TO workflow_change; RELEASE workflow_change");throw e;}
}
function event(db:DatabaseSync,id:string,version:number,kind:string,message:string){
  db.prepare("INSERT INTO quote_events(quote_id,version,kind,message,at) VALUES (?,?,?,?,?)")
    .run(id,version,kind,message,new Date().toISOString());
}
function expire(id:string,version:number) {
  const db=storage();
  const eligible=db.prepare("SELECT 1 FROM quote_workflow WHERE quote_id=? AND version=? AND status IN ('approved','sent') AND expires_on < ?")
    .get(id,version,commercialDate());
  if(!eligible) return;
  atomic(db,()=>{
    const changed=db.prepare("UPDATE quote_workflow SET status='expired' WHERE quote_id=? AND version=? AND status IN ('approved','sent') AND expires_on < ?")
      .run(id,version,commercialDate());
    if(changed.changes)event(db,id,version,"expired","Quote expired at the end of its validity period");
  });
}
export function getWorkflowStatus(id:string,version:number):QuoteStatus {
  expire(id,version);
  return (storage().prepare("SELECT status FROM quote_workflow WHERE quote_id=? AND version=?").get(id,version)?.status ?? "draft") as QuoteStatus;
}
export function listApprovedVersions(id:string):number[] {
  return storage().prepare("SELECT version FROM quote_workflow WHERE quote_id=? AND approved_at IS NOT NULL ORDER BY version DESC")
    .all(id).map(r=>Number(r.version));
}
export function getApprovalSnapshot(id:string,version:number):ApprovalSnapshot|null {
  const row=storage().prepare("SELECT snapshot,approved_at FROM quote_workflow WHERE quote_id=? AND version=? AND approved_at IS NOT NULL").get(id,version);
  return row ? {...JSON.parse(String(row.snapshot)),approvedAt:String(row.approved_at),approvedBy:"Nick"} : null;
}
export function getApprovedPackage(id:string,version:number) {
  const approval=getApprovalSnapshot(id,version);
  if(!approval) throw new QuoteError("This version has no approved customer quote.",404);
  const row=storage().prepare("SELECT customer_json,customer_pdf FROM quote_workflow WHERE quote_id=? AND version=?").get(id,version)!;
  return {quote:approval.quote,approval,status:getWorkflowStatus(id,version),customer:JSON.parse(String(row.customer_json)) as CustomerQuote,
    filename:approval.quote.number+"-v"+version+".pdf",pdf:Buffer.from(row.customer_pdf as Uint8Array)};
}

function snapshotRow(id:string,version:number) {
  return storage().prepare("SELECT status,snapshot,approved_at FROM quote_workflow WHERE quote_id=? AND version=?").get(id,version);
}
function firstLine(text:string){return text.trim().split(/\r?\n/)[0];}
function seedDetails(q:Quote,prior?:ReviewSnapshot):ReviewDetails {
  const lineDescriptions=Object.fromEntries(q.items.map(line=>{
    const previous=prior?.quote.items.find(i=>i.id===line.id);
    const custom=prior?.details.lineDescriptions[line.id];
    return [line.id,custom && previous && custom!==firstLine(previous.description) ? custom : firstLine(line.description)];
  }));
  return {scope:prior?.details.scope ?? "",leadTime:prior?.details.leadTime ?? "",terms:prior?.details.terms ?? "",
    pricingDecision:prior && q.totals.sellingPrice === prior.quote.totals.sellingPrice && q.marginPercent === prior.quote.marginPercent
      ? prior.details.pricingDecision ?? {kind:"standard",reason:""} : {kind:"standard",reason:""},
    expiresOn:prior?.details.expiresOn ?? commercialDate(new Date(Date.now()+30*86400000)),
    assumptions:prior?.details.assumptions ?? "",resolutions:{...prior?.details.resolutions},lineDescriptions,
    scopeConfirmed:false, leadTimeConfirmed:false};
}
function questionsFor(quote:Quote,runs:ReviewRun[]) {
  const result:ReviewSnapshot["questions"]=[];
  const applied=runs.filter(r=>r.appliedAt);
  // Distinguish the effective review per line from older applications on the same revision.
  const checked=new Set<string>();
  for(const run of (applied.length ? [...applied].sort((a,b)=>b.appliedAt!.localeCompare(a.appliedAt!)):runs.slice(0,1))) {
    const mappings=applied.length ? getDb().prepare("SELECT part_index,item_id FROM review_applied_items WHERE run_id=?").all(run.id) : [];
    run.parts.forEach((part,i)=>{
      const c=run.corrections[i];
      if(!c?.selected) return;
      if(applied.length){
        const key=String(mappings.find(r=>r.part_index===i)?.item_id ?? "");
        if(!quote.items.some(item=>item.id===key)||checked.has(key))return;
        checked.add(key);
      }
      const name=c.values.description || part.fields.description.value || "Part "+(i+1);
      for(const key of fieldKeys){
        if(key==="requirements" && part.fields[key].status!=="conflict")continue;
        if(c.values[key]?.trim() || (part.fields[key].status==="found" && c.values[key]===undefined))continue;
        result.push({id:run.id+"/"+i+"/"+key,label:name+" · "+fieldLabels[key]});
      }
    });
  }
  return result;
}
function draftSnapshot(q:Quote,current:boolean):ReviewSnapshot {
  const db=storage();
  const prior=db.prepare("SELECT snapshot FROM quote_workflow WHERE quote_id=? AND version<? ORDER BY version DESC LIMIT 1").get(q.id,q.version);
  const details=seedDetails(q,prior ? JSON.parse(String(prior.snapshot)):undefined);
  if(!current)return {quote:q,drawing:null,reviewRuns:[],questions:[],details};
  const state=getDrawingState(q.id);
  const source = blueprintOrigin(q.id);
  if (!prior) {
    if (source?.selectedRevision === state.selectedRevisionId && source?.job.shop_scope) {
      const installation = source.job.installation;
      details.scope = [source.job.shop_scope,
        installation === "included" ? "Installation included." :
          installation === "excluded" ? "Installation excluded." : ""].filter(Boolean).join("\n");
    }
  }
  watchDrawingChanges(db);
  const drawing=state.attachments.flatMap(a=>a.revisions).find(r=>r.id===state.selectedRevisionId) ?? null;
  const runs=drawing ? listReviews(q.id,drawing.id):[];
  const reviewRuns=runs.filter(r=>r.appliedAt);
  if(!reviewRuns.length && runs[0])reviewRuns.push(runs[0]);
  const questions = questionsFor(q,reviewRuns);
  if (q.benchmark?.takeoff) {
    questions.push({id:"drawing-takeoff-basis",
      label:"Confirm the drawing budget scope, stock quantities, labor allowances and excluded work."});
    for (const item of q.items.filter(item=>!item.costRows.length)) questions.push({
      id:"drawing-takeoff-coverage/"+item.id,
      label:"Identify the cost that covers "+item.description.split("\n")[0]+", or record why it is outside the bid.",
    });
  }
  if (source && source.selectedRevision === state.selectedRevisionId && !source.job.result) {
    const open = (source.job.source_callouts || []).filter(row =>
      row.status === "recovered" && row.part_id && !source.job.scope_decisions?.[row.part_id]);
    if (open.length) questions.push({
      id: "blueprint-open-scope", label: "Confirm whether these drawing items are included or excluded: " +
        [...new Set(open.map(row => row.label))].join(", "),
    });
  }
  return {quote:q,drawing,reviewRuns,details,questions};
}
function quoteAndRow(id:string,version?:number){
  const latest=getQuote(id);
  if(!latest)throw new QuoteError("Quote not found.",404);
  const q=!version||version===latest.version ? latest:getQuoteVersion(id,version);
  if(!q)throw new QuoteError("Quote version not found.",404);
  const row=snapshotRow(id,q.version);
  const currentDraft=q.version===latest.version && row?.status==="draft";
  const saved:ReviewSnapshot|null=row ? JSON.parse(String(row.snapshot)):null;
  const snap=saved && !currentDraft ? saved:draftSnapshot(q,q.version===latest.version);
  if(currentDraft && saved)snap.details=saved.details;
  return {latest,q,row,snap};
}

// Allocate indivisible cents by largest remainder. The public line prices always sum to the exact approved total.
function sellingLines(snap:ReviewSnapshot):CustomerQuote["lines"] {
  const {quote:q,details}=snap;
  const allocated = runPricing<number[]>({ operation: "allocate", total: q.totals.sellingPrice,
    costs: q.totals.items.map(item => item.cost) });
  return q.items.map((item, index) => ({
    description: details.lineDescriptions[item.id] ?? firstLine(item.description),
    quantity: item.quantity, sellingPrice: allocated[index],
  }));
}
function customerQuote(s:ReviewSnapshot,issuedOn:string):CustomerQuote {
  const {quote,details}=s;
  return {customer:quote.customer,jobName:quote.jobName,quoteNumber:quote.number,version:quote.version,
    scope:details.scope,leadTime:details.leadTime,terms:details.terms,expiresOn:details.expiresOn,issuedOn,
    lines:sellingLines(s),sellingPrice:quote.totals.sellingPrice};
}
export function getQuoteReview(id:string,version?:number):QuoteReviewView {
  const {latest,q,row,snap}=quoteAndRow(id,version);
  const saved=listQuoteVersions(id);
  const first=saved[saved.length-1];
  const versions=saved.map(v=>({version:v.version,status:getWorkflowStatus(id,v.version)}));
  const status=getWorkflowStatus(id,q.version);
  const approvedAt=row?.approved_at ? String(row.approved_at):null;
  const events=storage().prepare("SELECT version,message,at FROM quote_events WHERE quote_id=? ORDER BY id DESC").all(id)
    .map(r=>({version:Number(r.version),message:String(r.message),at:String(r.at)}));
  return {snapshot:snap,status,currentVersion:latest.version,approvedAt,versions,events,
    startingPrice:{version:first.version,sellingPrice:first.totals.sellingPrice,marginPercent:first.marginPercent},
    pricingReasonRequired:commercialEdit(first,q),
    customer:customerQuote(snap,commercialDate(approvedAt?new Date(approvedAt):new Date()))};
}
function validateText(value:unknown,max:number) {
  if(typeof value!=="string" || value.length>max)throw new QuoteError("Review text exceeds the allowed length.");
  return value.trim();
}
// A template filling an empty draft is routine estimating. A margin change or repricing an
// existing manual cost row is a commercial decision Nick can explain at approval.
function commercialEdit(first:Quote,current:Quote) {
  if (first.marginPercent !== current.marginPercent || (first.scrapBufferPct??0)!==(current.scrapBufferPct??0)) return true;
  if (!first.totals.estimatedCost) return false;
  for (const original of first.items) {
    const line=current.items.find(i=>i.id===original.id);
    if ((!line || line.quantity!==original.quantity) && original.costRows.some(r=>r.rate>0 && r.amount>0)) return true;
    for (const row of original.costRows) {
      const final=line?.costRows.find(r=>r.id===row.id);
      if (!row.estimate && row.rate>0 && (!final ||
          row.rate!==final.rate || row.amount!==final.amount || row.basis!==final.basis || row.review?.unitCost!==final.review?.unitCost)) return true;
    }
  }
  const originalRows = new Set(first.items.flatMap(i=>i.costRows.map(r=>i.id+"/"+r.id)));
  if (current.items.some(i=>i.costRows.some(r=>!r.estimate && r.rate>0 && !originalRows.has(i.id+"/"+r.id)))) return true;
  return false;
}
function readDetails(input:unknown,snap:ReviewSnapshot):ReviewDetails {
  if(!input || typeof input!=="object")throw new QuoteError("Supply the review details.");
  const v=input as Record<string,unknown>;
  const decision = v.pricingDecision as PricingDecision | undefined;
  if (decision !== undefined && (!decision || typeof decision !== "object" ||
      !Object.hasOwn(pricingDecisionLabels,decision.kind))) throw new QuoteError("Choose a pricing decision.");
  function values(field:string,keys:string[],max:number){
    const value=v[field];
    if(!value || typeof value!=="object" || Array.isArray(value))throw new QuoteError("Invalid review details.");
    return Object.fromEntries(keys.map(key=>[key,validateText((value as Record<string,unknown>)[key]??"",max)]));
  }
  return {scope:validateText(v.scope,16000),leadTime:validateText(v.leadTime,2000),terms:validateText(v.terms,10000),
    pricingDecision:{kind:decision?.kind ?? "standard", reason:validateText(decision?.reason ?? "",3000)},
    expiresOn:validateText(v.expiresOn,10),assumptions:validateText(v.assumptions,10000),
    scopeConfirmed:v.scopeConfirmed===true,leadTimeConfirmed:v.leadTimeConfirmed===true,
    resolutions:values("resolutions",snap.questions.map(q=>q.id),5000),
    lineDescriptions:values("lineDescriptions",snap.quote.items.map(i=>i.id),16000)};
}
function readyForApproval(snap:ReviewSnapshot) {
  const d=snap.details;
  if (snap.quote.benchmark?.takeoff && snap.quote.benchmark.takeoff.revisionId !== snap.drawing?.id)
    throw new QuoteError("The drawing changed. Rebuild the takeoff budget for the selected revision before approval.");
  if (snap.quote.items.some(item => item.quantityPending))
    throw new QuoteError("Confirm the order quantities on the quote before customer review.");
  checkBlueprintInputs(snap.quote,snap.drawing?.id ?? null);
  for (const line of snap.quote.items) {
    const routing = savedRouting(snap.quote.id, line.id, snap.quote.version);
    if (routing && routing.quantity !== line.quantity && line.costRows.some(row => routing.rowIds.includes(row.id)))
      throw new QuoteError("The quantity changed on " + line.description + ". Recalculate its work-center estimate before approval.");
  }
  if(snap.quote.customer.toLowerCase()===drawingDraftCustomer.toLowerCase())throw new QuoteError("Enter the customer name before continuing.");
  if(snap.quote.items.some(isDrawingDraftPart))throw new QuoteError("Add the parts to quote before continuing.");
  if(!d.scope||!d.scopeConfirmed)throw new QuoteError("Enter and confirm the customer scope.");
  if(!d.leadTime||!d.leadTimeConfirmed)throw new QuoteError("Enter and confirm the lead time.");
  if(!d.terms)throw new QuoteError("Enter the customer terms.");
  const parsed=new Date(d.expiresOn+"T12:00:00Z");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.expiresOn)||Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==d.expiresOn||d.expiresOn<commercialDate())
    throw new QuoteError("Choose a valid expiration date of today or later.");
  for(const q of snap.questions)if(!d.resolutions[q.id]?.trim())throw new QuoteError("Resolve the required detail for "+q.label+".");
  if(snap.quote.items.some(i=>!d.lineDescriptions[i.id]?.trim()))throw new QuoteError("Enter a customer description for every quoted line.");
  const first=listQuoteVersions(snap.quote.id).at(-1)!;
  if ((commercialEdit(first,snap.quote) || (d.pricingDecision && d.pricingDecision.kind !== "standard")) &&
      !d.pricingDecision?.reason.trim()) throw new QuoteError("Record the reason for this pricing decision before submitting.");
}
function checkVersion(id:string,version:number,drawingId:unknown) {
  const q=getQuote(id);
  if(!q||q.version!==version)throw new QuoteError("The quote has changed. Reopen the current version.",409);
  if(getDrawingState(id).selectedRevisionId!==drawingId)throw new QuoteError("The drawing selection has changed. Reopen this review.",409);
  return q;
}
function saveSnapshot(db:DatabaseSync,snap:ReviewSnapshot,status:QuoteStatus){
  db.prepare(`INSERT INTO quote_workflow(quote_id,version,status,snapshot,expires_on) VALUES(?,?,?,?,?)
    ON CONFLICT(quote_id,version) DO UPDATE SET status=excluded.status,snapshot=excluded.snapshot,expires_on=excluded.expires_on
    WHERE quote_workflow.approved_at IS NULL`)
    .run(snap.quote.id,snap.quote.version,status,JSON.stringify(snap),snap.details.expiresOn);
}
export async function changeWorkflow(id:string,body:unknown):Promise<QuoteReviewView> {
  if(!body || typeof body!=="object")throw new QuoteError("Supply a workflow action.");
  const data=body as Record<string,unknown>;
  const version=data.version;
  if(typeof version!=="number" || !Number.isSafeInteger(version)||version<1)throw new QuoteError("Choose a saved quote version.");
  const {action}=data;
  const db=storage();
  if(action==="approve"){
    const view=getQuoteReview(id,version);
    checkVersion(id,version,data.drawingId);
    if(view.status!=="awaiting_review")throw new QuoteError("Submit this version for review before approving it.",409);
    readyForApproval(view.snapshot);
    const approvedAt=new Date().toISOString();
    const publicQuote=customerQuote(view.snapshot,commercialDate(new Date(approvedAt)));
    const pdf=await renderCustomerPdf(publicQuote);
    atomic(db,()=>{
      checkVersion(id,version,data.drawingId);
      const write=db.prepare(`UPDATE quote_workflow SET status='approved',approved_at=?,customer_json=?,customer_pdf=?
        WHERE quote_id=? AND version=? AND status='awaiting_review' AND snapshot=?`)
        .run(approvedAt,JSON.stringify(publicQuote),pdf,id,version,JSON.stringify(view.snapshot));
      if(!write.changes)throw new QuoteError("The submitted review changed. Reopen it before approval.",409);
      freezeEngineeringApproval(view.snapshot, publicQuote, approvedAt);
      issueInternalCostSheet(view.snapshot.quote, publicQuote);
      event(db,id,version,"approval","Nick approved the price and customer scope");
    });
    return getQuoteReview(id,version);
  }
  if(action==="accept"||action==="decline") {
    atomic(db,()=>{
      if(getWorkflowStatus(id,version)!=="sent")throw new QuoteError("Record the customer decision on a sent, unexpired version.",409);
      const next=action==="accept"?"accepted":"declined";
      db.prepare("UPDATE quote_workflow SET status=? WHERE quote_id=? AND version=?").run(next,id,version);
      event(db,id,version,next,"Nick recorded the customer decision · "+statusLabels[next]);
    });
    return getQuoteReview(id,version);
  }
  if(action!=="save"&&action!=="submit"&&action!=="revise")throw new QuoteError("Unknown review action.");
  // Initialize the demo drawing and schema before this write transaction.
  getQuoteReview(id,version);
  checkVersion(id,version,data.drawingId);
  let resultVersion=version;
  atomic(db,()=>{
    const latest=checkVersion(id,version,data.drawingId);
    const status=getWorkflowStatus(id,version);
    if(action==="revise"){
      if(status==="draft")throw new QuoteError("This version is already a draft.",409);
      const q=updateQuote(id,latest);
      const snap=draftSnapshot(q,true);
      saveSnapshot(db,snap,"draft");event(db,id,q.version,"revision","Nick opened a new draft from version "+version);
      resultVersion=q.version;return;
    }
    if(status!=="draft")throw new QuoteError("Create a new draft version before changing its review details.",409);
    const snap=draftSnapshot(latest,true);
    const persisted=snapshotRow(id,version);
    if(persisted) snap.details=(JSON.parse(String(persisted.snapshot)) as ReviewSnapshot).details;
    const details=readDetails(data.details,snap);
    const customer=data.customer===undefined ? latest.customer : validateText(data.customer,500) || drawingDraftCustomer;
    const changed=customer!==latest.customer || JSON.stringify(details)!==JSON.stringify(readDetails(snap.details,snap));
    snap.quote={...latest,customer};
    snap.details=details;
    if(action==="submit")readyForApproval(snap);
    if(changed) snap.quote=updateQuote(id,snap.quote);
    resultVersion=snap.quote.version;
    saveSnapshot(db,snap,action==="submit"?"awaiting_review":"draft");
    event(db,id,resultVersion,action,action==="submit"?"Nick submitted the exact version for approval":"Nick saved the review details");
  });
  return getQuoteReview(id,resultVersion);
}
export function recordQuoteSent(id:string,version:number,receipt:string) {
  if(!receipt.trim())throw new QuoteError("A provider delivery receipt is required.");
  const db=storage();
  atomic(db,()=>{
    const row=snapshotRow(id,version);
    if(!row?.approved_at)throw new QuoteError("A delivery receipt must reference an approved version.",409);
    if(db.prepare("SELECT 1 FROM quote_events WHERE quote_id=? AND version=? AND kind='delivery'").get(id,version)) return;
    db.prepare("UPDATE quote_workflow SET status='sent' WHERE quote_id=? AND version=? AND status='approved'").run(id,version);
    event(db,id,version,"delivery","Provider confirmed delivery · "+receipt);
  });
}
