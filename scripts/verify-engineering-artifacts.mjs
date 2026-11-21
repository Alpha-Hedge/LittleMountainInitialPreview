import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireWeb = createRequire(path.join(root,"apps/web/package.json"));
const { parse } = requireWeb("csv-parse/sync");
const coldStart = performance.now();
await import("./test-typescript.mjs");
const { runPricing, runPython } = await import("../apps/web/lib/python-engine.ts");
const { renderCustomerPdf } = await import("../apps/web/lib/customer-pdf.ts");
const { renderInternalCostSheet } = await import("../apps/web/lib/internal-cost-sheet.ts");
const directory = path.join(root, ".test-results");
mkdirSync(directory, {recursive: true});
const output = mkdtempSync(path.join(directory, "engineering-artifacts-"));
const serviceMode = process.argv.includes("--service");
// The acceptance check contacts only a standalone test stack and submits stateless calculations.
const serviceToken = serviceMode ? parseEnv(readFileSync(path.join(root, ".env.nfip-test"),"utf8")).NFIP_API_TOKEN : null;
const inputs = {
  quantity: 10,
  stock: {width:1000,height:1000,blankWidth:120,blankHeight:80,margin:5,gap:3,sheetCost:80,allowRotation:true},
  operations: [
    {name:"Laser cell",unit:"mm cut",unitsPerPiece:400,unitsPerHour:20000,setupMinutes:6,hourlyRate:100},
    {name:"Press brake",unit:"bend",unitsPerPiece:2,unitsPerHour:40,setupMinutes:15,hourlyRate:80},
    {name:"Weld cell",unit:"mm weld",unitsPerPiece:120,unitsPerHour:3000,setupMinutes:6,hourlyRate:60},
  ],
};

async function generate() {
  let routing;
  if (serviceMode) {
    const response = await fetch("http://127.0.0.1:8141/v1/desk/routing", {method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+serviceToken},body:JSON.stringify(inputs)});
    assert.equal(response.status,200);
    routing = await response.json();
  } else {
    routing = await runPython("packages.costing.routing", inputs);
  }
  const routedRows = routing.rows.map((row,index) => ({...row,id:"route-"+index}));
  const items = [{id:"bracket",description:"Mounting bracket",quantity:10,costRows:routedRows},
    {id:"delivery",description:"Delivery",quantity:1,costRows:[{id:"delivery-fee",label:"=PRIVATE_DELIVERY",amount:1,rate:30,basis:"batch"}]}];
  const totals = runPricing({operation:"price",draft:{marginPercent:25,items}});
  const allocated = runPricing({operation:"allocate",total:totals.sellingPrice,costs:totals.items.map(item=>item.cost)});
  const quote = {id:"sample",version:1,customer:"Fixture Engineering",number:"TEST-001",jobName:"Bracket lot",items,
    totals,marginPercent:25,notes:"",createdAt:"2026-01-01T10:00:00Z",updatedAt:"2026-01-01T10:00:00Z"};
  const customer = {customer:quote.customer,jobName:quote.jobName,quoteNumber:quote.number,version:1,
    scope:"Fabricate ten mounting brackets and deliver one batch.",leadTime:"10 business days",terms:"Net 30",
    issuedOn:"2026-01-01",expiresOn:"2026-02-01",sellingPrice:totals.sellingPrice,
    lines:items.map((item,index)=>({description:item.description,quantity:item.quantity,sellingPrice:allocated[index]}))};
  const renderStart = performance.now();
  const csv = renderInternalCostSheet(quote, customer, id => id === "bracket" ?
    {quoteVersion:1,quantity:10,rowIds:routedRows.map(row=>row.id),result:routing} : null);
  const pdf = await renderCustomerPdf(customer);
  return {csv,pdf,totals,routing,renderMs:performance.now()-renderStart};
}

const first = await generate();
const firstMs = performance.now()-coldStart;
assert.equal(first.totals.estimatedCost,230);
assert.equal(first.totals.sellingPrice,306.67);
assert.equal(first.routing.sheetCount,1);
assert.deepEqual(first.routing.operationHours.map(h=>h.totalHours),[0.3,0.75,0.5]);
const pdfPath = path.join(output,"customer.pdf");
const csvPath = path.join(output,"internal.csv");
writeFileSync(pdfPath,first.pdf); writeFileSync(csvPath,first.csv);
execFileSync(process.execPath,[path.join(root,"scripts","render-source.mjs"),pdfPath,"application/pdf",output,"extract"],{cwd:root,windowsHide:true});
const pages = JSON.parse(readFileSync(path.join(output,"pages.json"),"utf8")).join(" ").replace(/\s+/g," ");
for (const field of ["Fabricate ten mounting brackets", "306.67", "266.67", "40.00", "Net 30"]) assert.ok(pages.includes(field),field);
for (const privateField of ["PRIVATE_DELIVERY", "Laser cell", "Press brake", "230.00", "gross margin"]) assert.ok(!pages.includes(privateField),privateField);
const rows = parse(readFileSync(csvPath),{bom:true,columns:true});
const summary = rows.find(row=>row.Record==="Quote total");
assert.equal(summary["Quote cost USD"],"230.00"); assert.equal(summary["Quote selling price USD"],"306.67");
assert.equal(summary["Target gross margin %"],"25");
const laser = rows.find(row=>row["Cost description"]==="Laser cell");
assert.equal(laser["Charge basis"],"Per batch"); assert.equal(laser["Planned setup hours"],"0.1");
assert.equal(laser["Planned run hours"],"0.2"); assert.equal(laser["Row cost USD"],"30.00");
assert.equal(rows.find(row=>row["Cost description"].includes("PRIVATE_DELIVERY"))["Cost description"],"'=PRIVATE_DELIVERY");
const timings = [], renderTimings = [];
for(let i=0;i<5;i++){
  const start=performance.now(); const next=await generate();
  timings.push(performance.now()-start); renderTimings.push(next.renderMs);
  assert.equal(next.csv, first.csv);
}
// Issue a real approval in an isolated desktop database. A later draft edits the rate.
process.env.LMM_DATA_DIR = output;
const { createQuote, updateQuote } = await import("../apps/web/lib/quotes.ts");
const { changeWorkflow, getQuoteReview, getApprovedPackage } = await import("../apps/web/lib/workflow.ts");
const { frozenInternalCostSheet } = await import("../apps/web/lib/internal-cost-sheet.ts");
const { getDb } = await import("../apps/web/lib/db.ts");
const manual = createQuote({customer:"Example shop",jobName:"Manual test",notes:"",marginPercent:25,items:[
  {id:"plate",description:"Bracket",quantity:10,costRows:[{id:"material",label:"Material",amount:1,rate:8,basis:"per_unit"},
    {id:"labor",label:"Internal labor",amount:1.5,rate:60,basis:"batch"}]},
  {id:"delivery",description:"Delivery",quantity:1,costRows:[{id:"freight",label:"Freight",amount:1,rate:30,basis:"batch"}]}]});
const review = getQuoteReview(manual.id);
const submitted = await changeWorkflow(manual.id,{action:"submit",version:manual.version,drawingId:null,details:{
  ...review.snapshot.details,scope:"Make brackets and deliver.",leadTime:"Two weeks",terms:"Net 30",scopeConfirmed:true,leadTimeConfirmed:true}});
const version = submitted.snapshot.quote.version;
await changeWorkflow(manual.id,{action:"approve",version,drawingId:null});
const issued = frozenInternalCostSheet(manual.id,version);
assert.ok(issued);
const issuedRows = parse(issued.csv,{bom:true,columns:true});
assert.equal(issuedRows.at(-1)["Quote cost USD"],"200.00");
assert.equal(issuedRows.at(-1)["Quote selling price USD"],"266.67");
assert.equal(issuedRows.find(r=>r["Cost description"]==="Material")["Charge basis"],"Per piece");
assert.equal(issuedRows.find(r=>r["Cost description"]==="Material")["Row cost USD"],"80.00");
const approvedPdf = getApprovedPackage(manual.id,version).pdf;
const revised = await changeWorkflow(manual.id,{action:"revise",version,drawingId:null});
const draft = revised.snapshot.quote;
draft.items[0].costRows[0].rate=12;
assert.equal(updateQuote(manual.id,draft).totals.estimatedCost,240);
assert.deepEqual(frozenInternalCostSheet(manual.id,version),issued);
assert.deepEqual(getApprovedPackage(manual.id,version).pdf,approvedPdf);
getDb().close();
const rounded = value=>Math.round(value);
console.log(JSON.stringify({routing:serviceMode?"warmed engineering API":"workstation runtime",coldIncludingModuleLoadMs:rounded(firstMs),warmBomToBothArtifactsMs:timings.map(rounded),
  warmArtifactRenderingOnlyMs:renderTimings.map(rounded),output},null,2));

