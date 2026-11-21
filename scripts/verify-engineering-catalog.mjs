import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium, expect } from "@playwright/test";
import { checkBlueprintRules } from "./check-blueprint-rules.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const configFile = path.join(root, ".env.nfip-test");
const config = parseEnv(await readFile(configFile, "utf8"));
const service = "http://127.0.0.1:8141";
assert.equal(config.NFIP_API_URL, service, "Use the separate test stack on port 8141.");
assert.ok(config.NFIP_API_TOKEN);
assert.equal((await fetch(service + "/health/ready")).status, 200);
const temp = path.join(root, ".test-results");
await mkdir(temp, { recursive: true });
const dir = await mkdtemp(path.join(temp, "engineering-catalog-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = String(probe.address().port);
await new Promise(resolve => probe.close(resolve));
const base = "http://127.0.0.1:" + port;
const server = spawn(process.execPath, [path.join(root, "scripts/web.mjs"), "start", "--hostname", "127.0.0.1", "--port", port], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {...process.env, LMM_DATA_DIR: dir, LMM_SUPABASE_DATA_DIR: path.join(dir, "unconnected"),
    NFIP_ARCHIVE_DATA_DIR: dir, NFIP_ARCHIVE_ENV: configFile, NFIP_API_URL: service, NFIP_API_TOKEN: config.NFIP_API_TOKEN},
});
let logs = "", browser;
for (const stream of [server.stdout, server.stderr]) stream.on("data", d => {logs = (logs + d).slice(-1200);});
const req = async (url, body, status=200) => {
  const res = await fetch(base + url, {method: body === undefined ? "GET" : "POST", redirect:"error",
    headers: {"Content-Type":"application/json"}, body: body === undefined ? undefined : JSON.stringify(body)});
  if (res.status !== status)
    throw Error(url+" expected "+status+" got "+res.status+" "+(await res.text()).slice(0,300));
  return res.json();
};
const tag = randomUUID().slice(0,8), company = "QA Metals " + tag, spec = "QA-304-" + tag, cell = "Forming center " + tag;
const center = {name:cell, unit:"USD/hour", hourly_rate:"60", default_setup_minutes:"15", efficiency_factor:"0.5", includes:"Setup and attended forming"};
const material = {spec_code:spec, category:"Plate", supplier:company, density_lb_per_in3:"0.25", cost_per_lb:"2.1234",
  default_scrap_pct:"12", k_factor:null, includes:"Supplier sheet purchase"};
const itemId = "bracket";
try {
  let ready = false;
  for (let i=0; i<120 && server.exitCode===null; i++) {
    try { if ((await fetch(base + "/api/quotes")).ok) { ready = true; break; } } catch {}
    await delay(250);
  }
  assert.ok(ready, "Isolated desk failed to start. " + logs);
  const exe = process.env.CHROME_PATH || [
    path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find(existsSync);
  browser = await chromium.launch({headless:true,executablePath:exe});
  const page = await browser.newPage({viewport:{width:1440,height:1100}});
  page.setDefaultTimeout(12_000);
  const browserErrors = [];
  page.on("pageerror", e => browserErrors.push(e.message));
  const today = (await req("/api/settings/catalog")).as_of;
  function day(offset) {
    const t = new Date(today + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate()+offset);
    return t.toISOString().slice(0,10);
  }
  const rateOn = day(-2);
  await page.goto(base + "/settings");
  await checkBlueprintRules(page, tag);
  const panel = page.locator("details.engineering-catalog");
  await panel.locator("summary").click();
  async function enterRate(kind, record) {
    await expect(panel.getByRole("combobox"), await panel.innerText()).toBeVisible();
    await panel.getByRole("combobox").selectOption(kind);
    const form = panel.locator("form");
    for (const [name, value] of Object.entries(record)) {
      if (name !== "unit" && value !== null) await form.locator('input[name="' + name + '"]').fill(value);
    }
    const response = page.waitForResponse(r => r.url()===base+"/api/settings/catalog" && r.request().method()==="POST");
    await form.getByRole("button", {name:"Save rate"}).click();
    assert.ok((await response).ok());
    await expect(panel.getByText("Dated rate saved.", {exact:true})).toBeVisible();
  }
  await enterRate("work-centers",{...center,effective_on:rateOn});
  await expect(panel.getByRole("cell",{name:cell,exact:true})).toBeVisible();
  await enterRate("materials",{...material,effective_on:rateOn});
  await expect(panel.getByRole("cell",{name:spec+" · "+company,exact:true})).toBeVisible();
  const current = await req("/api/settings/catalog");
  const m1 = current.materials.find(m=>m.spec_code===spec);
  const c1 = current.work_centers.find(c=>c.name===cell);
  assert.ok(m1?.id && c1?.id);
  await req("/api/settings/catalog",{kind:"materials",entry:{...material,effective_on:rateOn}},409);

  const quote = await req("/api/quotes",{customer:company,jobName:"Catalog rate control "+tag,notes:"Synthetic verification job.",marginPercent:25,
    items:[{id:itemId,description:"Small brackets",quantity:5,costRows:[]}]},201);
  const q = "/api/quotes/" + quote.id, route = q + "/routing";
  await page.goto(base + "/quotes/"+quote.id+"/estimate?itemId="+itemId);
  await page.getByRole("button",{name:"Calculate sheet stock and work-center time"}).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Sheet price source").selectOption(m1.id);
  const dims = {"Stock width (mm)":"254","Stock length (mm)":"127","Stock thickness (mm)":"2.54","Blank width (mm)":"127",
    "Blank length (mm)":"63.5","Edge margin on all sides (mm)":"0","Clear gap between blanks (mm)":"0"};
  for (const [label,value] of Object.entries(dims)) await dialog.getByLabel(label,{exact:true}).fill(value);
  await dialog.getByRole("button",{name:"Add operation"}).click();
  await dialog.getByLabel("Work-center rate source").selectOption(c1.id);
  await expect(dialog.getByLabel("Work-center cost ($/hour)",{exact:true})).toHaveValue("60");
  await expect(dialog.getByLabel("Setup per batch (minutes)",{exact:true})).toHaveValue("15");
  await dialog.getByRole("combobox",{name:/^Production unit/}).selectOption("bend");
  await dialog.getByLabel("Units per piece (bend)",{exact:true}).fill("2");
  await dialog.getByLabel(/^Throughput.*bend per hour/).fill("20");
  await dialog.getByRole("button",{name:"Calculate routing",exact:true}).click();
  await expect(dialog.getByLabel("Calculated routing")).toContainText("$80.30");
  const applied = page.waitForResponse(r => r.url()===base+route && r.request().postDataJSON()?.action==="apply");
  await dialog.getByRole("button",{name:"Save routing costs to quote"}).click();
  assert.ok((await applied).ok());
  const first = await req(q);
  const firstState = (await req(route+"?itemId="+itemId)).saved;
  assert.equal(firstState.stockSource.weightLb,1.25); // 10 in x 5 in x 0.1 in x 0.25 lb/in³.
  assert.equal(firstState.stockSource.cost,2.65);
  assert.equal(firstState.stockSource.material.id,m1.id);
  assert.equal(firstState.centerSources[0].id,c1.id);
  assert.equal(firstState.result.piecesPerSheet,4);
  assert.equal(firstState.result.sheetCount,2);
  assert.equal(firstState.result.yieldPercent,62.5);
  assert.equal(firstState.result.operationHours[0].setupHours,0.25);
  assert.equal(firstState.result.operationHours[0].runHours,1);
  assert.equal(first.totals.estimatedCost,80.30);
  assert.equal(first.totals.sellingPrice,107.07);
  const stock = {...firstState.stock};
  const operation = {...firstState.operations[0]};
  const payload = {itemId, quoteVersion:first.version, stock, operations:[operation], action:"preview"};
  await req(route,{...payload,operations:[{...operation,hourlyRate:55}]},422);
  const overridden = await req(route,{...payload,operations:[{...operation,hourlyRate:55,overrideReason:"Fixture discount on this order"}]});
  assert.equal(overridden.total,74.05);
  await req("/api/settings/catalog",{kind:"materials",entry:{...material,cost_per_lb:"3.20",effective_on:day(-1)}});
  const fresh = await req("/api/settings/catalog",{kind:"work-centers",entry:{...center,hourly_rate:"90",default_setup_minutes:"30",efficiency_factor:"1",effective_on:day(-1)}});
  const m2 = fresh.materials.find(m=>m.spec_code===spec);
  const c2 = fresh.work_centers.find(c=>c.name===cell);
  assert.notEqual(m2.id,m1.id); assert.notEqual(c2.id,c1.id);
  assert.deepEqual((await req(route+"?itemId="+itemId)).saved,firstState);
  await req(route,payload,409);
  const newer = await req(route,{...payload,action:"apply",stock:{...stock,materialId:m2.id},
    operations:[{...operation,centerId:c2.id,hourlyRate:90,setupMinutes:30}]});
  assert.equal(newer.total,98);
  const latest = await req(q);
  assert.equal(latest.totals.sellingPrice,130.67);
  assert.equal(latest.items[0].costRows.length,first.items[0].costRows.length);
  const prior = (await req(q+"/approval?version="+first.version)).snapshot.quote;
  assert.deepEqual(prior.totals,first.totals);
  await page.goto(base+"/quotes/"+quote.id+"/estimate?version="+first.version);
  await page.getByText("See the costs saved with this quote",{exact:true}).click();
  await page.getByText("Stock and work-center inputs · version "+first.version,{exact:true}).click();
  const basis = page.locator(".routing-basis");
  await expect(basis).toContainText(rateOn);
  await expect(basis).toContainText("1.25 lb per sheet");
  await expect(basis).toContainText("efficiency 0.5");
  const scheduled = await req("/api/settings/catalog",{kind:"materials",entry:{...material,cost_per_lb:"4",effective_on:day(3)}});
  assert.equal(scheduled.materials.find(m=>m.spec_code===spec).id,m2.id);
  assert.deepEqual(browserErrors,[]);
  console.log("Browser and live PostgreSQL catalog verified: 1.25 lb per sheet, two $2.65 sheets, 15 min setup, 1 h running at 50% efficiency, $80.30 cost and $107.07 sale. Changed rates produced $98.00 cost and $130.67 sale. Future rates, override reasons and frozen original inputs passed.");
} finally {
  await browser?.close();
  if (server.exitCode === null) { const stopped = once(server,"exit"); server.kill(); await stopped; }
}
