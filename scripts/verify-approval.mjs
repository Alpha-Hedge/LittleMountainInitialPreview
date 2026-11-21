import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script=fileURLToPath(import.meta.url);
const root=path.dirname(path.dirname(script));
const phase=process.argv[2];
if(!phase){
  const output=path.join(root,".test-results");
  mkdirSync(output,{recursive:true});
  const directory=mkdtempSync(path.join(output,"approval-"));
  for(const step of ["approve","reopen"]){
    execFileSync(process.execPath,[script,step],{cwd:root,env:{...process.env,LMM_DATA_DIR:directory},stdio:"inherit",windowsHide:true});
  }
  console.log("Verified customer PDF and restart archive in",directory);
}else{
  const directory=process.env.LMM_DATA_DIR;
  assert.ok(directory?.startsWith(path.join(root,".test-results","approval-")));
  await import("./test-typescript.mjs");
  const {getQuoteReview,changeWorkflow,getApprovedPackage,recordQuoteSent,getWorkflowStatus}=await import("../apps/web/lib/workflow.ts");
  const {createQuote,getQuote,updateQuote}=await import("../apps/web/lib/quotes.ts");
  const {uploadDrawing,getDrawingState}=await import("../apps/web/lib/drawings.ts");
  const {getDb}=await import("../apps/web/lib/db.ts");
  const id="demo-mounting-plate";
  const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
  const file=path.join(directory,"approved.pdf");
  const meta=path.join(directory,"expected.json");
  if(phase==="approve"){
    let view=getQuoteReview(id);
    assert.equal(view.status,"draft");
    const {extractReview}=await import("../apps/web/lib/reviews.ts");
    const {fieldKeys}=await import("../apps/web/lib/review-types.ts");
    const revision=view.snapshot.drawing.id;
    const fields=Object.fromEntries(fieldKeys.map(key=>[key,{status:"found",value:key==="description"?"Mounting plate":"Confirmed",evidence:[]}]));
    fields.finish={status:"conflict",value:"Bare or zinc",evidence:[]};
    await extractReview(id,revision,view.currentVersion,async()=>({parts:[{fields}],model:"fixture",provider:"fixture",raw:"test"}));
    view=getQuoteReview(id);
    assert.equal(view.snapshot.questions.length,1);
    const details={...view.snapshot.details,scope:"Fabricate ten mounting plates with zinc finish and deliver one batch.",
      scopeConfirmed:true,leadTime:"10 working days after purchase order",leadTimeConfirmed:true,
      terms:"Payment due 30 days from invoice.",assumptions:"INTERNAL_FIXTURE_ASSUMPTION"};
    const action=(action,extra={})=>changeWorkflow(id,{action,version:view.snapshot.quote.version,drawingId:revision,details,...extra});
    await assert.rejects(action("approve"),/Submit this version/);
    await assert.rejects(action("submit"),/Resolve the required detail/);
    details.resolutions={[view.snapshot.questions[0].id]:"Zinc finish confirmed by customer."};
    view=await action("submit");
    const version=view.snapshot.quote.version;
    assert.equal(view.status,"awaiting_review");
    const simultaneous=await Promise.allSettled([action("approve"),action("approve")]);
    if(simultaneous.every(v=>v.status==="rejected"))throw simultaneous[0].reason;
    assert.deepEqual(simultaneous.map(v=>v.status).sort(),["fulfilled","rejected"]);
    const pkg=getApprovedPackage(id,version);
    assert.equal(pkg.approval.drawing.id,revision);
    assert.equal(pkg.approval.reviewRuns.length,1);
    assert.equal(pkg.status,"approved");
    assert.deepEqual(pkg.customer.lines.map(v=>v.sellingPrice),[226.67,40]);
    assert.equal(pkg.customer.sellingPrice,266.67);
    writeFileSync(file,pkg.pdf);writeFileSync(meta,JSON.stringify({version,digest:sha(pkg.pdf),revision}));
    execFileSync(process.execPath,[path.join(root,"scripts","render-source.mjs"),file,"application/pdf",directory,"extract"],{windowsHide:true});
    const pages=JSON.parse(readFileSync(path.join(directory,"pages.json"),"utf8"));
    assert.equal(pages.length,1);
    const text=pages.join(" ").replace(/\s+/g," ");
    for(const value of [pkg.quote.number,"Version "+version,pkg.quote.jobName,pkg.quote.customer,"Scope of work",
      "ten mounting plates","10 working days","Payment due 30 days","226.67","40.00","266.67",details.expiresOn])assert.ok(text.includes(value),value+" missing from PDF");
    for(const value of ["Plate material","Fabrication labor","INTERNAL_FIXTURE_ASSUMPTION","Target gross margin","200.00","60.00"])assert.ok(!text.includes(value),value+" leaked into PDF");
    const grouped=getDrawingState(id).attachments[0];
    const next=uploadDrawing(id,{bytes:readFileSync(path.join(root,"fixtures","drawings","bracket-set-incomplete.pdf")),fileName:"Revised bracket.pdf"},grouped.id,"Verification C");
    assert.notEqual(next.selectedRevisionId,revision);
    const copy=getQuoteReview(id);
    assert.equal(copy.currentVersion,version+1);
    assert.equal(copy.status,"draft");
    assert.equal(copy.snapshot.details.scopeConfirmed,false);
    assert.equal(getApprovedPackage(id,version).approval.drawing.id,revision);
    const latest=getQuote(id);
    latest.items[0].costRows[0].rate=10;
    assert.equal(updateQuote(id,latest).totals.estimatedCost,220);
    assert.equal(sha(getApprovedPackage(id,version).pdf),sha(pkg.pdf));
    console.log("Verified required-detail resolution, version-specific approval, concurrent approval, PDF prices and disclosure, drawing and price revisions.");
    const {drawingDraftCustomer,drawingDraftPart}=await import("../apps/web/lib/quote-start.ts");
    let uploaded=createQuote({customer:drawingDraftCustomer,jobName:"Bench bracket drawing",notes:"",marginPercent:25,
      items:[{id:"drawing-starter",description:drawingDraftPart,quantity:1,costRows:[]}]});
    const detailsFor = () => ({...getQuoteReview(uploaded.id).snapshot.details,scope:"Fabricate one bench bracket.",
      scopeConfirmed:true,leadTime:"Two weeks",leadTimeConfirmed:true,terms:"Payment on delivery."});
    const finish=(action,customer)=>changeWorkflow(uploaded.id,{action,customer,version:uploaded.version,drawingId:null,details:detailsFor()});
    await assert.rejects(finish("submit"),/Enter the customer name/);
    await assert.rejects(finish("submit","Bench Shop"),/Add the parts to quote/);
    assert.equal(getQuote(uploaded.id).customer,drawingDraftCustomer);
    uploaded=updateQuote(uploaded.id,{...uploaded,items:[{...uploaded.items[0],description:"Bench bracket"}]});
    const saved=await finish("save","Bench Shop");
    uploaded=saved.snapshot.quote;
    assert.equal(uploaded.customer,"Bench Shop");
    const prepared=await finish("submit");
    uploaded=prepared.snapshot.quote;
    assert.equal(prepared.status,"awaiting_review");
    await finish("approve");
    assert.equal(getApprovedPackage(uploaded.id,uploaded.version).customer.customer,"Bench Shop");
    console.log("Verified upload-first placeholders block approval and a customer saved during review is used on the PDF.");
  }else{
    const {version,revision,digest}=JSON.parse(readFileSync(meta,"utf8"));
    let pkg=getApprovedPackage(id,version);
    assert.equal(pkg.approval.drawing.id,revision);
    assert.equal(sha(pkg.pdf),digest);
    recordQuoteSent(id,version,"fixture-receipt");
    recordQuoteSent(id,version,"fixture-receipt");
    assert.equal(getWorkflowStatus(id,version),"sent");
    assert.equal(getQuoteReview(id,version).events.filter(event=>event.message.includes("fixture-receipt")).length,1);
    await changeWorkflow(id,{version,action:"accept"});
    assert.equal(getWorkflowStatus(id,version),"accepted");
    assert.equal(sha(getApprovedPackage(id,version).pdf),digest);
    assert.equal(getQuoteReview(id).status,"draft");
    const view=getQuoteReview(id);
    const details={...view.snapshot.details,scopeConfirmed:true,leadTimeConfirmed:true,
      pricingDecision:{kind:"scope_change",reason:"Customer specified a higher-cost blank."}};
    const submitted=await changeWorkflow(id,{action:"submit",version:view.currentVersion,drawingId:view.snapshot.drawing.id,details});
    const nextVersion=submitted.currentVersion;
    await changeWorkflow(id,{action:"approve",version:nextVersion,drawingId:view.snapshot.drawing.id});
    recordQuoteSent(id,nextVersion,"second-receipt");
    await changeWorkflow(id,{action:"decline",version:nextVersion});
    assert.equal(getWorkflowStatus(id,nextVersion),"declined");
    const revised=await changeWorkflow(id,{action:"revise",version:nextVersion,drawingId:view.snapshot.drawing.id});
    const again=await changeWorkflow(id,{action:"submit",version:revised.currentVersion,drawingId:view.snapshot.drawing.id,details: {...revised.snapshot.details,scopeConfirmed:true,leadTimeConfirmed:true}});
    await changeWorkflow(id,{action:"approve",version:again.currentVersion,drawingId:view.snapshot.drawing.id});
    // Advance the validity boundary for just this isolated fixture.
    getDb().prepare("UPDATE quote_workflow SET expires_on='2000-01-01' WHERE quote_id=? AND version=?").run(id,again.currentVersion);
    assert.equal(getWorkflowStatus(id,again.currentVersion),"expired");
    await assert.rejects(changeWorkflow(id,{action:"accept",version:again.currentVersion}),/unexpired/);
    console.log("Verified immutable approved PDF after restart, old-version receipt deduplication, acceptance, decline, automatic expiration, and revision history.");
  }
  getDb().close();
}
