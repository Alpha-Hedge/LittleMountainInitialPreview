import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtempSync, readFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import "./test-typescript.mjs";

process.env.LMM_DATA_DIR = mkdtempSync(path.join(os.tmpdir(),"lmm-blueprint-desk-"));
const {createBlueprintDraft} = await import("../apps/web/lib/blueprint-draft.ts");
const {blueprintOrigin,engineeringDb} = await import("../apps/web/lib/engineering-ledger.ts");
const {getQuoteReview,changeWorkflow,getApprovedPackage} = await import("../apps/web/lib/workflow.ts");
const {frozenInternalCostSheet} = await import("../apps/web/lib/internal-cost-sheet.ts");
const {getDrawingState} = await import("../apps/web/lib/drawings.ts");
const {getQuote,updateQuote} = await import("../apps/web/lib/quotes.ts");
const source = readFileSync(new URL("../fixtures/drawings/mounting-plate-assembly.pdf",import.meta.url));
const history = {kind:"historical_job",reference:"previous/approved/v2",excerpt:"Earlier approved fixture"};
const rule = {kind:"nick_rule",reference:"setup-rule/v1",excerpt:"Repeat setup allowance"};
const row = {id:"work", label:"Cutting",category:"cut",stage:"run",basis:"batch",amount:"1.234567",
  rate:"1000",cost_usd:"1234.57",work_center:"Shop cell",basis_text:"Reviewed fixture time",
  citations:["Dated rate card"],rule_citations:[rule]};
const stock = {...row,id:"stock",label:"material",category:"material",stage:"stock",basis:"per_unit",
  amount:"2",rate:"1.5",cost_usd:"6.00",work_center:null};
const line = {part_id:"BR",description:"Two brackets",quantity:2,weight_lb:"5",material_family:"carbon steel",
  processes:["CUT"],estimated_cost_usd:"1240.57",selling_price_usd:"1654.09",rows:[row,stock],
  baseline_rows:[row,stock],history:[{citation:history}],rules:[rule],metrics:{pierces:2},warnings:[]};
const job = {id:randomUUID(),state:"ready",version:2,customer_name:"Example",job_name:"New brackets",
  drawing:{id:randomUUID(),sha256:createHash("sha256").update(source).digest("hex"),
    filename:"Brackets.pdf",revision:1,type:"CUSTOMER_PDF",drawing_key:randomUUID()},
  model:"fixture review",settings:{snapshot_name:"Example shop rates",demo:true},notes:"Quote as drawn.",
  ast:{parts:[{part_id:"BR",confidence:.95}]},original_ast:{parts:[{part_id:"BR",confidence:.87}]},
  review_log:[{path:"parts.0"}],result:{lines:[line],totals:{estimated_cost_usd:"1240.57",selling_price_usd:"1654.09",
    gross_margin_pct:"25"},settings:{},stock_groups:[],warnings:[]}};
const before = engineeringDb().prepare("SELECT count(*) AS n FROM engineering_blueprint_drafts").get().n;
assert.throws(()=>createBlueprintDraft(job,Buffer.from("%PDF-different")), /match/);
assert.throws(()=>createBlueprintDraft({...job,result:{...job.result,totals:{...job.result.totals,selling_price_usd:"1.00"}}},source),/amounts differ/);
assert.equal(engineeringDb().prepare("SELECT count(*) AS n FROM engineering_blueprint_drafts").get().n,before);
const q = createBlueprintDraft(job,source);
assert.equal(createBlueprintDraft(job,source).id,q.id);
assert.equal(q.items[0].costRows[0].rate,1234.57);
assert.equal(q.items[0].costRows[1].basis,"per_unit");
assert.equal(q.totals.estimatedCost,1240.57);
assert.equal(getDrawingState(q.id).selectedRevisionId,blueprintOrigin(q.id).selectedRevision);
const review = getQuoteReview(q.id);
const drawingId = review.snapshot.drawing.id;
const details = {...review.snapshot.details,scope:"Two brackets",scopeConfirmed:true,leadTime:"Three days",
  leadTimeConfirmed:true,terms:"Net 30"};
const submitted = await changeWorkflow(q.id,{action:"submit",version:q.version,drawingId,details});
const version = submitted.snapshot.quote.version;
await changeWorkflow(q.id,{action:"approve",version,drawingId});
const archived = JSON.parse(engineeringDb().prepare("SELECT payload FROM engineering_approvals WHERE quote_id=? AND version=?").get(q.id,version).payload);
assert.deepEqual(archived.pricing_inputs.blueprint.original_ast,job.original_ast);
assert.equal(archived.drawing_id,job.drawing.id);
assert.equal(archived.lines[0].entered.retrieval.weight_lb,"5");
assert.equal(archived.lines[0].confidence_score,.87);
assert.equal(archived.lines[0].ai_proposed.blueprint.rows[0].amount,row.amount);
assert.equal(archived.lines[0].nick_approved.sellingPrice,1654.09);
for (const ref of [rule.reference,history.reference,job.drawing.id])
  assert(archived.lines[0].citations.some(c=>c.reference===ref));
const issued = getApprovedPackage(q.id,version);
const staff = frozenInternalCostSheet(q.id,version);
assert(staff.csv.includes("1240.57"));
assert(!JSON.stringify(issued.customer).includes("fixture time"));
const revised = await changeWorkflow(q.id,{action:"revise",version,drawingId});
const edited = revised.snapshot.quote;
edited.items[0].quantity=3;
updateQuote(q.id,edited);
await assert.rejects(changeWorkflow(q.id,{action:"submit",version:getQuote(q.id).version,drawingId,details}),/batch quantity/);
assert.deepEqual(getApprovedPackage(q.id,version).pdf,issued.pdf);
assert.equal(frozenInternalCostSheet(q.id,version).csv,staff.csv);
const dxfJob = {...job,id:randomUUID(),drawing:{...job.drawing,id:randomUUID(),filename:"brackets.dxf",type:"NATIVE_DXF"}};
const dq = createBlueprintDraft(dxfJob);
const d = await changeWorkflow(dq.id,{action:"submit",version:dq.version,drawingId:null,details});
await changeWorkflow(dq.id,{action:"approve",version:d.snapshot.quote.version,drawingId:null});
const dxfPayload = JSON.parse(engineeringDb().prepare("SELECT payload FROM engineering_approvals WHERE quote_id=?").get(dq.id).payload);
assert.equal(dxfPayload.drawing_id,dxfJob.drawing.id);
const manualJob = {...job,id:randomUUID(),state:"review_required",result:null,
  ast:{parts:[{part_id:"BR",description:"Two brackets",quantity:2}]},settings:{...job.settings,gross_margin_pct:"25"}};
const heldJob = {...manualJob,id:randomUUID(),ast:{source_release_hold:"Drawing not issued",parts:[
  {part_id:"Tube-1",description:"Rail",quantity:2,material_family:"Steel",section_designation:"HSS 2x2x1/4",
    finish:"Shop primer",requirements:["Cap exposed tube ends."],welds:[{field_weld:true}]},
  {part_id:"Angle-1",description:"Angle bracket"},
]}};
const scopeJob = {...heldJob,id:randomUUID(),ast:{parts:[
  ...heldJob.ast.parts,
  {part_id:"Gutter",description:"Drain gutter"},
  {part_id:"Lighting",description:"Lighting"},
  {part_id:"Anchors",description:"Anchors"},
]},source_callouts:["Gutter","Lighting","Anchors"].map(part_id=>({part_id,label:part_id,status:"recovered"})),
  scope_decisions:{Gutter:"include",Lighting:"exclude"}};
const scoped = createBlueprintDraft(scopeJob, source, true);
assert.deepEqual(scoped.items.map(i=>i.id),["Tube-1","Angle-1","Gutter"]);
assert.match(scoped.notes,/Scope open \(held out of budget\): Anchors/);
assert.match(getQuoteReview(scoped.id).snapshot.questions[0].label,/Anchors/);
const budget = createBlueprintDraft(heldJob,source,true);
const uncertainTube = {...heldJob,id:randomUUID(),flags:[{kind:"low_confidence",path:"parts.0",reason:"Check the assembly reading."}]};
assert.equal(createBlueprintDraft(uncertainTube,source,true).items[0].quantityPending,true);
const checkedTube = {...uncertainTube,id:randomUUID(),ast:{parts:heldJob.ast.parts.map((p,i)=> i ? p : {
  ...p,quantity:7,evidence:[{source:"review",fields:["quantity"],excerpt:"Customer ordered seven."}]
})}};
assert.equal(createBlueprintDraft(checkedTube,source,true).items[0].quantity,7);
assert.equal(createBlueprintDraft(checkedTube,source,true).items[0].quantityPending,undefined);
assert.equal(createBlueprintDraft({...checkedTube,id:randomUUID(),flags:[{kind:"conflict",path:"parts.0.quantity",reason:"Check conflicting quantities."}]},source,true).items[0].quantityPending,true);
assert.equal(getDrawingState(budget.id).selectedRevisionId,blueprintOrigin(budget.id).selectedRevision);
assert.equal(budget.items[0].quantity,2);
assert.match(budget.items[0].description,/Finish: Shop primer/);
assert.match(budget.notes,/Cap exposed tube ends/);
assert.match(budget.notes,/confirm site weld and access/);
assert.match(budget.notes,/Enter ordered quantities for: Angle bracket/);
assert.equal(budget.items[1].description,"Angle bracket");
assert.equal(budget.items[1].quantityPending,true);
assert.equal(createBlueprintDraft(heldJob,source,true).id,budget.id);
const budgetDrawing = getDrawingState(budget.id).selectedRevisionId;
const pendingDetails = {...getQuoteReview(budget.id).snapshot.details, scope:"Rails and angle", scopeConfirmed:true};
await assert.rejects(changeWorkflow(budget.id,{action:"submit",version:budget.version,drawingId:budgetDrawing,
  details:pendingDetails}),/Confirm the order quantities/);
const budgetPriced = updateQuote(budget.id,{...budget,notes:"Our internal budget",items:[{id:"Tube-1",description:"Rail",
  quantity:2,costRows:[{id:"rail-work",label:"Budget allowance",basis:"batch",amount:1,rate:150}]}]});
const budgetDetails = {...getQuoteReview(budget.id).snapshot.details,...details,lineDescriptions:{"Tube-1":"Two rails"},
  pricingDecision:{kind:"standard",reason:"Confirmed stock and allowance"}};
const budgetReview = await changeWorkflow(budget.id,{action:"submit",version:budgetPriced.version,drawingId:budgetDrawing,
  details:budgetDetails});
assert.equal(budgetReview.status,"awaiting_review");
await changeWorkflow(budget.id,{action:"approve",version:budgetReview.snapshot.quote.version,drawingId:budgetDrawing});
const manual = createBlueprintDraft(manualJob,source,true);
assert.equal(manual.totals.sellingPrice,0);
assert.equal(createBlueprintDraft(manualJob,source,true).id,manual.id);
const manualDrawing = getDrawingState(manual.id).selectedRevisionId;
let manualDetails = {...getQuoteReview(manual.id).snapshot.details,scope:"Saw and drill tube",scopeConfirmed:true,
  leadTime:"Three days",leadTimeConfirmed:true,terms:"Net 30",pricingDecision:{kind:"standard",reason:"Confirmed material and saw schedule"}};
await assert.rejects(changeWorkflow(manual.id,{action:"submit",version:manual.version,drawingId:manualDrawing,details:manualDetails}),/confirmed cost/);
const priced = updateQuote(manual.id,{...manual,items:[{id:"tube",description:"Saw and drill tube",quantity:2,
  costRows:[{id:"tube-shop",label:"Stock and confirmed shop work",basis:"batch",amount:1,rate:150}]}]});
manualDetails = {...manualDetails,lineDescriptions:{tube:"Saw and drill two tubes"}};
const sentForReview = await changeWorkflow(manual.id,{action:"submit",version:priced.version,drawingId:manualDrawing,details:manualDetails});
await changeWorkflow(manual.id,{action:"approve",version:sentForReview.snapshot.quote.version,drawingId:manualDrawing});
assert.equal(getQuote(manual.id).totals.sellingPrice,200);
const sample = {...manualJob,id:randomUUID(),installation:"excluded",flags:[],ast:{parts:[{
  part_id:"BENCH",description:"Fabricated mild steel brackets",quantity:4,stock_form:"plate",
  material_family:"carbon steel",material_grade:"A36",thickness_in:.25,dimension_basis:"flat",
  outline:{kind:"rectangle",width_in:10,height_in:5},
  holes:[{cutting_method:"drill",count:2}],welds:[{field_weld:false,count:1}],
}]}};
const benchmark = createBlueprintDraft(sample,source,true,true);
assert.equal(benchmark.totals.estimatedCost,239.71);
assert.equal(benchmark.totals.sellingPrice,319.61);
assert.equal(benchmark.items[0].costRows.filter(row=>row.basis==="batch").length,1);
assert.equal(benchmark.items[0].costRows.find(row=>row.estimate.operationId==="stock").rate,2.55);
assert.equal(benchmark.items[0].costRows.find(row=>row.estimate.operationId==="weld").rate,75);
assert.equal(benchmark.items[0].costRows.find(row=>row.estimate.operationId==="drill").rate,85);
assert.equal(createBlueprintDraft(sample,source,true,true).id,benchmark.id);
const ungraded = createBlueprintDraft({...sample,id:randomUUID(),
  ast:{parts:[{...sample.ast.parts[0],material_family:null,material_grade:null,dimension_basis:"unknown"}]},
  flags:[{kind:"unverified_source",path:"parts.0.dimension_basis",reason:"Blank dimension basis missing."}],
},source,true,true);
assert.ok(ungraded.items[0].costRows.some(row=>row.label==="Mild steel stock allowance"));
assert.ok(ungraded.benchmark.unpriced.some(note=>note.includes("Verify the assumed mild steel grade")));
const benchReview = getQuoteReview(benchmark.id);
const benchDrawing = benchReview.snapshot.drawing.id;
const benchDetails = {...benchReview.snapshot.details,scope:"Four fabricated brackets",scopeConfirmed:true,
  leadTime:"Three days",leadTimeConfirmed:true,terms:"Net 30"};
const benchSubmitted = await changeWorkflow(benchmark.id,{action:"submit",version:benchmark.version,drawingId:benchDrawing,details:benchDetails});
const benchVersion = benchSubmitted.snapshot.quote.version;
await changeWorkflow(benchmark.id,{action:"approve",version:benchVersion,drawingId:benchDrawing});
const benchCustomer = getApprovedPackage(benchmark.id,benchVersion);
const benchStaff = frozenInternalCostSheet(benchmark.id,benchVersion);
assert.ok(benchStaff.csv.includes("239.71"));
assert.ok(!JSON.stringify(benchCustomer.customer).includes("payroll"));
await changeWorkflow(benchmark.id,{action:"revise",version:benchVersion,drawingId:benchDrawing});
const working = getQuote(benchmark.id);
const editedSample = updateQuote(benchmark.id,{...working,items:[{...working.items[0],quantity:8}]});
assert.equal(editedSample.totals.estimatedCost,441.92);
assert.equal(getQuote(editedSample.id).benchmark.name,"U.S. shop benchmarks");
assert.deepEqual(getApprovedPackage(benchmark.id,benchVersion).pdf,benchCustomer.pdf);
assert.equal(frozenInternalCostSheet(benchmark.id,benchVersion).csv,benchStaff.csv);

const {getEstimatingProfiles, saveEstimatingSettings} = await import("../apps/web/lib/estimating.ts");
const custom = saveEstimatingSettings({...getEstimatingProfiles().shop,stockTrimPercent:5,rates:[
  {id:"steel-quote",name:"A36 from local supplier",category:"material",form:"sheet / plate",grade:"ASTM A36",
    family:"carbon steel",density:.283,thicknessIn:.25,unit:"lb",value:2,minimumCost:0,source:"Fixture invoice",
    includes:"Quarter inch plate by weight"},
  {id:"custom-weld",name:"Shop welding",category:"labor",group:"Labor",budgetRole:"weld",budgetAmount:.4,
    unit:"hour",value:92,minimumCost:0,source:"Fixture work center",includes:"Welder and rig"},
]},true);
const real = createBlueprintDraft({...sample,id:randomUUID()},source,true,custom);
assert.equal(real.benchmark.demo,false);
assert.ok(real.items[0].costRows.some(row=>row.estimate.rateId==="custom-weld" && row.rate===92 && row.amount===.4));
assert.ok(real.items[0].costRows.some(row=>row.estimate.rateId==="steel-quote" && row.rate===2 && /5%/.test(row.estimate.rationale)));
assert.ok(real.items[0].costRows.every(row=>!row.estimate.demo));
assert.ok(real.benchmark.unpriced.some(check=>check.includes("drill openings")));
assert.deepEqual(getApprovedPackage(q.id,version).pdf,issued.pdf);
assert.equal(frozenInternalCostSheet(q.id,version).csv,staff.csv);
console.log("Verified prepared drafts, review-stamped quote approval, PDF/DXF revision links, quantity gates, and immutable approval exports.");
console.log("Verified U.S. benchmark material, labor, machine and consumable rows, batch setup once, repricing, and frozen earlier exports.");
