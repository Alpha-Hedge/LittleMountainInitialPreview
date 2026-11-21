import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { chromium, expect } from "@playwright/test";

const cfg=parseEnv(await readFile(".env.nfip-test","utf8"));
assert.equal(cfg.NFIP_API_URL,"http://127.0.0.1:8141");
const root=path.resolve(".test-results");
await mkdir(root,{recursive:true});
const dir=await mkdtemp(path.join(root,"shop-assistant-"));
const probe=createServer().listen(0,"127.0.0.1");
await once(probe,"listening");
const port=probe.address().port;
await new Promise(resolve=>probe.close(resolve));
const base="http://127.0.0.1:"+port;
const audio=process.argv.slice(2).find(arg=>arg.endsWith(".wav"));
const child=spawn(process.execPath,["scripts/web.mjs","start","--hostname","127.0.0.1","--port",String(port)],{
  windowsHide:true,stdio:"ignore",env:{...process.env,
    LMM_DATA_DIR:dir,NFIP_ARCHIVE_DATA_DIR:dir,NFIP_ARCHIVE_ENV:".env.nfip-test",
    NFIP_API_URL:cfg.NFIP_API_URL,NFIP_API_TOKEN:cfg.NFIP_API_TOKEN,
    LMM_SUPABASE_DATA_DIR:path.join(dir,"unconnected"),LMM_SUPABASE_WORKSPACE_KIND:"verification",
  },
});
const executablePath=process.env.CHROME_PATH || [
  path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
  "/usr/bin/chromium","/usr/bin/google-chrome",
].find(existsSync);
let browser;
async function json(url, body) {
  const response=await fetch(base+url,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{});
  const data=await response.json();
  assert.ok(response.ok,url+" "+JSON.stringify(data).slice(0,500));
  return data;
}

async function photo() {
  const formats=await json("/api/sketch-conversions");
  const record=formats.find(x=>x.state==="released"&&x.filename==="slotted-mounting-plate.png");
  assert.ok(record,"Seed the isolated slotted plate from the real drawing audit.");
  const url="/api/sketch-conversions/"+record.drawing_id;
  const saved=await json(url);
  const reading=structuredClone(saved.reading);
  for (const part of reading.parts) part.annotations=part.annotations.filter(a=>a.kind!=="width");
  const answer=await json("/api/assistant",{
    kind:"sketch",id:saved.drawing_id,version:saved.version,draft:reading,turns:[],inspect:true,page:1,
    instruction:"Read the written overall plate width on the photo. Add the missing width annotation only. Use the dimensions explicitly written on the image.",
  });
  assert.ok(answer.draft,answer.answer);
  assert.ok(answer.draft.parts.some(p=>p.annotations.some(a=>a.kind==="width"&&/^\s*120(?:\.0+)?(?:\s*mm)?\s*$/.test(a.value))),JSON.stringify(answer.changes));
  assert.ok((await json(url)).version===saved.version);
  console.log("The assistant recovered the omitted 120 mm width from the original uploaded sketch.");
}

async function blueprint() {
  const jobs=await json("/api/blueprints/jobs");
  const sample=jobs.find(x=>x.state==="ready"&&x.drawing.type==="CUSTOMER_PDF"&&x.customer_name==="Blueprint acceptance fixture");
  assert.ok(sample,"Seed the engineering blueprint acceptance fixture.");
  const saved=await json("/api/blueprints/jobs/"+sample.id);
  const proofUrl="/api/blueprints/jobs/"+sample.id+"/proof";
  const before=await json(proofUrl,{version:saved.version,ast:saved.ast,settings:saved.settings});
  const part=saved.ast.parts[0];
  const result=await json("/api/assistant",{
    kind:"blueprint",id:saved.id,version:saved.version,draft:saved.ast,inspect:true,turns:[],page:1,
    instruction:"On part "+part.part_id+", add one new 0.5-inch round through hole cut by plasma. Put its center 1.25 inches from left and 1.75 inches from bottom. Keep all existing features.",
  });
  assert.ok(result.draft,result.answer);
  const found=result.draft.parts[0].holes.at(-1);
  assert.equal(found.diameter_in,.5);
  assert.equal(found.center_x_in,1.25);
  assert.equal(found.center_y_in,1.75);
  assert.equal(found.cutting_method,"cut");
  assert.deepEqual(result.checks,before.issues.slice(0,8));
  const after=await json(proofUrl,{version:saved.version,ast:result.draft,settings:saved.settings});
  assert.ok(after.pdf);
  assert.equal(after.geometry[0].paths.filter(x=>x.kind==="hole").length,before.geometry[0].paths.filter(x=>x.kind==="hole").length+1);
  assert.ok((await json("/api/blueprints/jobs/"+sample.id)).version===sample.version);
  console.log("The blueprint assistant proposed a 1/2-inch hole with written offsets and passed server geometry validation.");
}

async function voice(page) {
  if(!audio)return;
  await page.goto(base+"/quotes/demo-mounting-plate");
  await page.getByText("Ask AI",{exact:true}).click();
  await page.getByRole("button",{name:"Use microphone"}).click();
  const stop=page.getByRole("button",{name:"Stop recording"});
  await expect(stop).toBeVisible();
  await page.waitForTimeout(4500);
  const response=page.waitForResponse(r=>r.url().endsWith("/api/assistant/transcribe"),{timeout:50000});
  await stop.click();
  const req=await response;
  const result=await req.json();
  assert.ok(req.ok(),result.error);
  await expect(page.getByLabel("Your instruction")).toHaveValue(/\blabor\b.*\b(two|2)\s+hours?\b/i);
  console.log("Chrome recorded a synthetic microphone stream and the live voice endpoint returned editable text.");
}

async function datedPlan() {
  const saved=await json("/api/quotes",{
    customer:"QA only",jobName:"Tube assembly",notes:"Use shop time for layout. Verify field access separately.",marginPercent:25,
    items:[{id:"tube-assembly",description:"HSS tube assembly",quantity:2,costRows:[]}],
  });
  const quote=await json("/api/assistant",{
    kind:"quote",id:saved.id,version:saved.version,draft:saved,turns:[],inspect:false,page:1,
    planCosts:true,
    instruction:"Plan the work. Add only a 30-minute batch of Bench setup to the tube assembly using the current shop rate. Keep field access open.",
  });
  assert.ok(quote.draft,quote.answer);
  assert.ok(quote.checkedBy);
  const [setup]=quote.draft.items[0].costRows;
  assert.equal(setup.estimate.rateId,"shop-setup");
  assert.equal(setup.estimate.demo,true);
  assert.match(setup.estimate.rateEffectiveOn,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(setup.basis,"batch");
  assert.equal(setup.amount,.5);
  assert.equal(quote.estimatedCost,30);
  assert.equal(quote.sellingPrice,40);
  console.log("The work plan priced a 30-minute batch of setup at the effective demo rate, with a dated rate and basis on the row.");
  const unknown=await json("/api/assistant",{
    kind:"quote",id:saved.id,version:saved.version,draft:saved,turns:[],inspect:false,page:1,planCosts:true,
    instruction:"Estimate only subcontract hot-dip galvanizing for this assembly. Supplier price and galvanizing allowance are both unknown.",
  });
  assert.ok(unknown.checkedBy);
  assert.equal(unknown.draft,null);
  assert.ok(unknown.checks.some(check=>/rate|supplier|subcontract|price|cost|galvaniz/i.test(check)));
}

async function budget(page) {
  const jobs=await json("/api/blueprints/jobs");
  const candidates=jobs.filter(x=>x.state==="review_required" && /2208_AWNING-A6\.7/i.test(x.drawing.filename));
  if(!candidates.length) {
    console.log("The real awning is absent from this test ledger. Run the real drawing audit first to exercise its prepared draft.");
    return;
  }
  const job=await json("/api/blueprints/jobs/"+candidates[0].id);
  assert.ok(job.ast.source_release_hold);
  await page.setViewportSize({width:1440,height:960});
  await page.goto(base+"/blueprints/"+job.id);
  const setup=page.getByRole("tab",{name:"Quote setup"});
  const check=page.getByRole("tab",{name:"Check the drawing"});
  const found=page.getByRole("tab",{name:"What the AI found"});
  await expect(setup).toBeVisible();
  await expect(page.getByRole("img",{name:"Drawing preview, page 1"}).first()).toBeVisible();
  await page.screenshot({path:path.join(dir,"drawing-review-desktop.png")});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(dir,"drawing-review-mobile.png")});
  const proposedScope = "QA budget scope for estimating review " + job.version;
  await page.getByLabel("Scope note (optional)").fill(proposedScope);
  await setup.focus();
  await setup.press("ArrowRight");
  await expect(check).toBeFocused();
  await expect(check).toHaveAttribute("aria-selected","true");
  await expect(page.getByRole("heading",{name:"Check a reading"})).toBeVisible();
  await expect(page.getByLabel("Scope note (optional)")).toBeHidden();
  await found.click();
  await expect(page.getByRole("region",{name:"What the AI found"})).toBeVisible();
  await setup.click();
  await expect(page.getByLabel("Scope note (optional)")).toHaveValue(proposedScope);
  await found.click();
  await page.getByRole("button",{name:"Open quote draft"}).click();
  await page.waitForURL(/\/quotes\/[a-f0-9-]+$/,{timeout:20000});
  await expect(page.getByText("Ask AI",{exact:true})).toBeVisible();
  const quotePath="/api"+new URL(page.url()).pathname;
  const draft=await json(quotePath);
  assert.match(draft.notes,/Drawing scope to check/);
  assert.ok(draft.notes.includes(proposedScope));
  assert.ok(draft.items.some(item=>item.quantityPending && item.description!=="New drawing quote"));
  await expect(page.getByRole("button",{name:"Review drawing",exact:true})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"Open original drawing in a new tab"})).toBeVisible();
  await page.getByRole("link",{name:"Plan costs with AI"}).click();
  await expect(page.getByRole("button",{name:"Plan the work"})).toBeVisible();
  await expect(page.getByText("Installed budget",{exact:true})).toBeVisible({timeout:390000});
  await page.getByRole("link", {name:"Check quantities",exact:true}).click();
  const confirm=page.getByRole("button",{name:"Confirm order quantity"}).first();
  await confirm.click();
  await page.getByRole("button",{name:"Save changes",exact:true}).click();
  const item=draft.items.find(line=>line.quantityPending);
  await expect.poll(async()=>(await json(quotePath)).items.find(line=>line.id===item.id)?.quantityPending).toBeUndefined();
  await page.reload();
  await expect(page.getByText("Installed budget",{exact:true})).toBeVisible();
  await expect(page.getByText("Drawing takeoff budget",{exact:true})).toBeVisible();
  const reopened = await json(quotePath);
  assert.ok(reopened.totals.sellingPrice > 0);
  assert.ok(reopened.benchmark.unpriced.length > 0);
  assert.equal(reopened.benchmark.takeoff.scope,"installed");
  await page.screenshot({path:path.join(dir,"budget-quote-mobile.png"),fullPage:true});
  console.log("Nick’s awning draft carried the original, unsaved scope and named lines. Quantity confirmation reopened correctly at phone width.");
}

async function drawingTakeoff(page) {
  const jobs = await json("/api/blueprints/jobs");
  const awning = jobs.find(job => job.state==="review_required" && /2208_AWNING-A6\.7/i.test(job.drawing.filename));
  assert.ok(awning,"Requires the awning source in the isolated engineering ledger.");
  if (!process.argv.includes("--manual-preview")) {
    await page.goto(base+"/blueprints/"+awning.id);
    await page.getByRole("button",{name:"Open quote draft",exact:true}).click();
    await page.waitForURL(/\/quotes\/[a-z0-9-]+$/);
    const url = new URL(page.url()).pathname;
    const original = await json("/api"+url);
    await expect(page.getByTestId("selling-price")).toHaveText("Pending");
    await expect(page.getByRole("region",{name:"Automatic drawing budget"})).toBeVisible();
    const claimed = await json("/api"+url+"/takeoff",{version:original.version,automatic:true});
    assert.ok(["taking_off","checking"].includes(claimed.state));
    await page.reload();
    await expect(page.getByText("Installed budget",{exact:true})).toBeVisible({timeout:390000});
    const saved = await json("/api"+url);
    assert.equal(saved.version,original.version+1);
    assert.ok(saved.benchmark.takeoff.checkedBy);
    assert.ok(saved.items.some(item=>item.costRows.some(row=>row.estimate?.workType==="Stock")));
    assert.ok(saved.items.some(item=>item.costRows.some(row=>row.estimate?.workType==="Site & delivery")));
    assert.ok(saved.totals.shopOnlySellingPrice>0 && saved.totals.shopOnlySellingPrice<saved.totals.sellingPrice);
    assert.ok(saved.totals.sellingPrice>original.totals.sellingPrice);
    const status = await json("/api"+url+"/takeoff");
    assert.deepEqual(status,{state:"ready",version:saved.version});
    await writeFile(path.join(dir,"awning-automatic-budget.json"),JSON.stringify(saved,null,2));
    console.log(JSON.stringify({original:original.totals.sellingPrice,installed:saved.totals.sellingPrice,
      shopOnly:saved.totals.shopOnlySellingPrice,reviewedBy:saved.benchmark.takeoff.checkedBy,
      rows:saved.items.flatMap(item=>item.costRows).length,store:dir}));
    return;
  }
  const draft = await json("/api/blueprints/jobs/"+awning.id+"/manual-draft",{version:awning.version,prepareOnly:true});
  const url = "/quotes/"+draft.id;
  const original = await json("/api"+url);
  await page.goto(base+url);
  await page.getByRole("button",{name:"Build drawing budget"}).click();
  const dialog = page.getByRole("dialog",{name:"Drawing budget"});
  if (process.argv.includes("--installed")) await dialog.getByLabel("Scope").selectOption("installed");
  const wait = page.waitForResponse(response=>response.url().endsWith("/takeoff")&&response.request().method()==="POST",{timeout:390000});
  await dialog.getByRole("button",{name:"Calculate budget"}).click();
  const response = await wait;
  const proposed = await response.json();
  assert.ok(response.ok(),JSON.stringify(proposed));
  assert.ok(proposed.rows.some(row=>row.group==="Stock" && row.unit==="lb"));
  assert.ok(proposed.rows.some(row=>/weld|fit-up/i.test(row.label) && row.unit==="hour"));
  assert.equal(proposed.rows.some(row=>row.group==="Site & delivery"),process.argv.includes("--installed"));
  assert.ok(proposed.rows.every(row=>row.basis.startsWith("Page ")&&row.assumption));
  await writeFile(path.join(dir,"awning-takeoff-preview.json"),JSON.stringify(proposed,null,2));
  assert.equal((await json("/api"+url)).version,original.version);
  await expect(dialog.getByRole("region",{name:"Proposed drawing budget"})).toBeVisible();
  await dialog.getByRole("button",{name:"Save budget to quote"}).click();
  await expect(dialog).toBeHidden();
  const saved = await json("/api"+url);
  assert.equal(saved.version,original.version+1);
  assert.equal(saved.totals.sellingPrice,proposed.sellingPrice);
  assert.deepEqual((await json("/api"+url)).items.map(item=>item.quantity),original.items.map(item=>item.quantity));
  await page.reload();
  await expect(page.getByText(proposed.scope==="installed"?"Installed budget":"Shop-only budget",{exact:true})).toBeVisible();
  console.log(JSON.stringify({source:awning.drawing.filename,model:proposed.model,scope:proposed.scope,
    original:original.totals.sellingPrice,after:saved.totals.sellingPrice,direct:proposed.directCost,
    contingency:proposed.contingencyCost,rows:proposed.rows.length,open:proposed.checks.length,directory:dir}));
}

try{
  await expect.poll(async()=>{try{return (await fetch(base+"/api/quotes")).status;}catch{return 0;}},{timeout:30000}).toBe(200);
  browser=await chromium.launch({executablePath,headless:true,args:audio ? [
    "--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture="+path.resolve(audio),
  ] : []});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const mic=await browser.newPage({permissions:["microphone"]});
  const awning=await browser.newPage();
  const target="/quotes/demo-mounting-plate";
  const command="Change Fabrication labor (hours) on the first line from 1.5 to 2 hours for this batch. Leave everything else alone.";
  const quote=async()=>{
    await page.goto(base+target);
    await page.getByText("Ask AI",{exact:true}).click();
    await page.getByLabel("Your instruction").fill(command);
    await page.getByLabel("Look at the drawing").uncheck();
    const response=page.waitForResponse(r=>r.url().endsWith("/api/assistant"),{timeout:120000});
    await page.getByRole("button",{name:"Send",exact:true}).click();
    const result=await response;
    const answer=await result.json();
    assert.ok(result.ok()&&answer.draft,answer.error || answer.answer);
    const changes=page.getByRole("region",{name:"Suggested changes"});
    await expect(changes).toBeVisible({timeout:120000});
    await expect(changes.getByText("$306.67",{exact:true})).toBeVisible();
    assert.equal((await json("/api"+target)).totals.sellingPrice,266.67);
    await changes.getByRole("button",{name:"Apply suggested changes"}).click();
    await page.getByRole("button",{name:"Save changes",exact:true}).click();
    await expect.poll(async()=>(await json("/api"+target)).totals.sellingPrice,{timeout:25000}).toBe(306.67);
    console.log("Chrome previewed, applied and saved a two-hour labor edit at $306.67. Preview did not write.");
  };
  const checks=process.argv.includes("--takeoff-only") ? [drawingTakeoff(awning)] : process.argv.includes("--budget-only") ? [budget(awning)]
    : process.argv.includes("--quote-only") ? [quote(),datedPlan()] : [quote(),photo(),blueprint(),voice(mic),datedPlan(),budget(awning)];
  const results=await Promise.allSettled(checks.map(async check=>{
    try { await check; } catch (failure) { console.error(failure); throw failure; }
  }));
  assert.ok(results.every(x=>x.status==="fulfilled"));
}finally{
  await browser?.close();
  if(child.exitCode===null){
    const closed=once(child,"exit");
    child.kill();
    await closed;
  }
}
