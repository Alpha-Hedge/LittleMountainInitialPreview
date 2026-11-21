import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const testConfig = path.join(root, ".env.nfip-test");
const config = parseEnv(await readFile(testConfig, "utf8"));
const origin = "http://127.0.0.1:8141";
assert.equal(config.NFIP_API_URL, origin, "Use the isolated test stack on 8141");
assert.ok(config.NFIP_API_TOKEN, "Test stack token required");
const parent = path.join(root, ".test-results");
await mkdir(parent, {recursive:true});
const directory = await mkdtemp(path.join(parent, "engineering-archive-"));
process.env.LMM_DATA_DIR = directory;
process.env.LMM_SUPABASE_DATA_DIR = path.join(directory, "unconnected");
process.env.NFIP_ARCHIVE_DATA_DIR = directory;
process.env.NFIP_ARCHIVE_ENV = testConfig;
process.env.NFIP_API_URL = origin;
process.env.NFIP_API_TOKEN = config.NFIP_API_TOKEN;
const originalFetch = globalThis.fetch;
const readRemote = async route => {
  const response = await originalFetch(origin + route, {redirect:"error", headers:{Authorization:"Bearer " + config.NFIP_API_TOKEN}});
  assert.equal(response.status, 200, "Engineering test stack read " + route);
  return response;
};
assert.equal((await originalFetch(origin + "/health/ready")).status, 200);

const {createQuote,getQuote,updateQuote} = await import("../apps/web/lib/quotes.ts");
const {getDb} = await import("../apps/web/lib/db.ts");
const {getQuoteReview,changeWorkflow} = await import("../apps/web/lib/workflow.ts");
const {uploadDrawing} = await import("../apps/web/lib/drawings.ts");
const {suggestOperations,applyOperations} = await import("../apps/web/lib/estimating.ts");
const {generateHistory,applyHistory} = await import("../apps/web/lib/history.ts");
const {saveJob} = await import("../apps/web/lib/jobs.ts");
const {archiveStatus,syncEngineeringArchive} = await import("../apps/web/lib/engineering-archive.ts");
const templateId = "plate-fab", itemId = "plate";
const drawingBytes = await readFile(path.join(root,"fixtures","drawings","bracket-set-incomplete.pdf"));
const sourceBytesB = await readFile(path.join(root,"fixtures","drawings","mounting-plate-preview.png"));
const today = new Date().toISOString().slice(0,10);
const row = {id:"handling",label:"Handling",amount:1,rate:12,basis:"batch"};
const make = suffix => createQuote({
  customer:"Archive verification workshop",jobName:today + " · " + suffix,notes:"Synthetic verification job.",marginPercent:25,
  items:[
    { id:itemId,description:"Support plate\nMaterial / grade: A36\nDimensions: 120 x 80\nUnits: mm",quantity:10,costRows:[{...row}] },
    { id:"freight",description:"Delivery",quantity:1,costRows:[{...row,id:"trip",label:"Delivery",rate:30}] },
  ],
});
const approve = async id => {
  let view = getQuoteReview(id);
  const details = {
    ...view.snapshot.details, scope:"Make and deliver the reviewed plate quantity.",scopeConfirmed:true,
    leadTime:"Five working days",leadTimeConfirmed:true,terms:"Payment due on delivery.",
    resolutions:Object.fromEntries(view.snapshot.questions.map(q=>[q.id,"Checked against the verification request."])),
    pricingDecision:{kind:"standard",reason:"Reviewed labor and delivery allowances for this revision."},
  };
  const drawingId = view.snapshot.drawing?.id ?? null;
  view = await changeWorkflow(id,{action:"submit",version:view.currentVersion,drawingId,details});
  view = await changeWorkflow(id,{action:"approve",version:view.currentVersion,drawingId});
  return view.snapshot.quote;
};

// Only the newly created temporary database gets a unique sequence range.
assert.equal(getQuote("demo-mounting-plate").id,"demo-mounting-plate");
getDb().prepare("UPDATE quotes SET sequence=? WHERE id=?").run(Date.now()*1000 + randomInt(1000),"demo-mounting-plate");
const precedent = make("completed source");
applyOperations(precedent.id,{...suggestOperations(precedent.id,itemId,templateId),itemId,templateId});
const approvedPrior = await approve(precedent.id);
await syncEngineeringArchive();
assert.equal(archiveStatus().stored, 1, archiveStatus().issue || "The historical approval must reach the test stack");
saveJob(precedent.id, approvedPrior.version, {
  completedOn:today,edit:0,scopeChanges:"",overrideReasons:"",
  rows:[{itemId,kind:"setup",operation:"Set up and lay out",amount:0.5,unit:"h",unitCost:60},
        {itemId,kind:"labor",operation:"Fabricate and deburr",amount:2,unit:"h",unitCost:60}],
});
const next = make("quoted from precedent");
const drawing = uploadDrawing(next.id,{bytes:drawingBytes,fileName:"A36 request.pdf"},"","A");
const firstDrawing = drawing.selectedRevisionId;
const fixture = createServer(async(req,res)=>{
  for await (const _ of req) {}
  const data = Object.fromEntries(["op1","op2"].map(op=>[op,{factor:1,confidence:0.82,
    assumption:"Use the same fixtures",basis:"Actual hours on the completed plate batch",sources:["R1"]}]));
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(data)}}]}));
});
fixture.listen(0,"127.0.0.1");
await once(fixture,"listening");
try {
  process.env.VISION_PROVIDER="llama.cpp";
  process.env.VISION_MODEL="archive-verification-fixture";
  process.env.VISION_BASE_URL="http://127.0.0.1:" + fixture.address().port + "/v1";
  const run = await generateHistory(next.id,itemId,templateId);
  assert.equal(run.records[0].quoteId,precedent.id);
  const revisedHours = run.advice.map(a=>({...a,hours:a.hours+0.25,reason:"Extra alignment for this run",recurring:false}));
  applyHistory(next.id,run.id,revisedHours);
  const first = await approve(next.id);
  assert.equal(archiveStatus().pending,1);
  const lookup = q => "/v1/quotes/"+encodeURIComponent(q.number)+"/versions/"+q.version;

  // Drop the acknowledgment *after* the real API committed this version, then
  // retry normally using the outbox backoff and the same frozen payload.
  let lostReceipt;
  globalThis.fetch = async(url, options) => {
    const response = await originalFetch(url,options);
    if (String(url)===origin+"/v1/quote-versions" && JSON.parse(options.body).quote_number===first.number && response.ok && !lostReceipt) {
      lostReceipt = await response.json();
      throw Error("Synthetic lost acknowledgment");
    }
    return response;
  };
  try { await syncEngineeringArchive(); } finally { globalThis.fetch=originalFetch; }
  assert.ok(lostReceipt?.id);
  assert.equal(archiveStatus().pending,1);
  assert.equal(archiveStatus().stored,1);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await syncEngineeringArchive();
  const receipt = JSON.parse(getDb().prepare("SELECT receipt FROM engineering_approvals WHERE quote_id=? AND version=?").get(next.id,first.version).receipt);
  assert.equal(receipt.id,lostReceipt.id);
  assert.equal(receipt.already_saved,true);
  const frozen = await (await readRemote(lookup(first))).json();
  assert.equal(frozen.job_name,first.jobName);
  assert.equal(frozen.pricing_inputs.totals.sellingPrice,first.totals.sellingPrice);
  assert.equal(frozen.pricing_inputs.drawing.id,firstDrawing);
  const sourceA = await (await readRemote("/v1/drawings/"+frozen.drawing_id)).json();
  assert.equal(sourceA.drawing_key,drawing.attachments[0].id);
  assert.equal(sourceA.revision,1);
  assert.deepEqual(Buffer.from(await (await readRemote("/v1/drawings/"+frozen.drawing_id+"/source")).arrayBuffer()),drawingBytes);
  const reviewed = frozen.lines.find(l=>l.line_key===itemId);
  assert.equal(Number(reviewed.confidence_score),0.82);
  assert.equal(reviewed.ai_proposed.operations.length,run.advice.length);
  for (const advice of run.advice) {
    assert.equal(reviewed.ai_proposed.operations.find(a=>a.operationId===advice.operationId).hours,advice.hours);
    assert.equal(reviewed.nick_approved.costRows.find(r=>r.estimate?.operationId===advice.operationId).amount,advice.hours+0.25);
  }
  assert.ok(reviewed.citations.some(c=>c.kind==="historical_job"&&c.reference.includes(precedent.id)));
  assert.ok(reviewed.citations.some(c=>c.kind==="drawing"&&c.reference===firstDrawing));
  assert.match(reviewed.override_reason,/Extra alignment/);
  const manual = frozen.lines.find(l=>l.line_key==="freight");
  assert.equal(manual.ai_proposed,null);
  assert.equal(manual.confidence_score,null);
  assert.equal(manual.nick_approved.estimatedCost,30);

  const revisedDrawing = uploadDrawing(next.id,{bytes:sourceBytesB,fileName:"Plate revision B.png"},drawing.attachments[0].id,"B");
  const latest = getQuote(next.id);
  latest.items.find(i=>i.id==="freight").costRows[0].rate=45;
  updateQuote(next.id,latest);
  const second = await approve(next.id);
  assert.ok(second.version>first.version);
  process.env.NFIP_API_URL="http://127.0.0.1:1";
  try { await syncEngineeringArchive(); } finally {process.env.NFIP_API_URL=origin;}
  assert.equal(archiveStatus().pending,1);
  await new Promise(resolve=>setTimeout(resolve,1100));
  await syncEngineeringArchive();
  const newer = await (await readRemote(lookup(second))).json();
  assert.equal(newer.lines.find(l=>l.line_key==="freight").nick_approved.estimatedCost,45);
  assert.equal(newer.pricing_inputs.drawing.id,revisedDrawing.selectedRevisionId);
  assert.notEqual(newer.drawing_id,frozen.drawing_id);
  const sourceB = await (await readRemote("/v1/drawings/"+newer.drawing_id)).json();
  assert.equal(sourceB.drawing_key,sourceA.drawing_key);
  assert.equal(sourceB.revision,2);
  assert.deepEqual(Buffer.from(await (await readRemote("/v1/drawings/"+newer.drawing_id+"/source")).arrayBuffer()),sourceBytesB);
  assert.deepEqual(await(await readRemote(lookup(first))).json(),frozen);
  assert.equal(archiveStatus().pending,0);
  console.log("Verified test-stack archive from approval to PostgreSQL and MinIO, original files, human/AI comparison, source citations, saved versions, offline retry and lost-acknowledgment reconciliation.");
} finally {
  globalThis.fetch = originalFetch;
  fixture.close();
}
