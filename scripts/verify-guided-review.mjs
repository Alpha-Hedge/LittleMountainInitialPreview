// Read-only against saved work. Only the assistant transport is replaced to exercise slow and stale replies.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const base = new URL(process.argv[2] || "http://127.0.0.1:3100");
assert.ok(["localhost","127.0.0.1"].includes(base.hostname));
const out = path.resolve(".test-results","guided-review");
await mkdir(out,{recursive:true});
const api = async pathname => {
  const response = await fetch(new URL(pathname,base));
  assert.ok(response.ok, pathname + " returned " + response.status);
  return response.json();
};
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || [
  path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome","/usr/bin/chromium",
].find(existsSync)});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const photos = await api("/api/sketch-conversions");
  let sketch;
  for (const photo of photos.filter(row => row.state==="needs_review")) {
    const candidate = await api("/api/sketch-conversions/"+photo.drawing_id);
    if (candidate.solution?.pins.some(pin=>pin.field) && candidate.solution.pins.length>1) {sketch=candidate;break;}
  }
  assert.ok(sketch,"Requires a saved sketch with at least two checks and one missing input.");
  await page.goto(new URL("/sketches/photo/"+sketch.drawing_id,base).href);
  await page.getByRole("button",{name:"Review measurements",exact:true}).click();
  const checks = page.getByRole("region",{name:"Measurement checks"});
  const select = checks.getByLabel("Jump to a check");
  const idx = sketch.solution.pins.findIndex(pin=>pin.field);
  const pin = sketch.solution.pins[idx];
  await select.selectOption(String(idx));
  const input = checks.getByRole("textbox");
  await input.fill("Fixture answer");
  await select.selectOption(String(idx===0?1:0));
  await select.selectOption(String(idx));
  await expect(input).toHaveValue("Fixture answer");
  if(await checks.getByLabel("Show checks for").count()) {
    await checks.getByLabel("Show checks for").selectOption(pin.part_id||"");
    await expect(select.locator("option")).toHaveCount(sketch.solution.pins.filter(row=>row.part_id===pin.part_id).length);
    await checks.getByLabel("Show checks for").selectOption("*");
  }
  await input.fill("");
  await checks.getByRole("button",{name:"Show check markers on photo"}).click();
  await page.getByRole("button",{name:"Go to check 1",exact:true}).click({force:true});
  await expect(select).toHaveValue("0");
  await page.setViewportSize({width:390,height:844});
  await checks.getByRole("button",{name:"View on photo",exact:true}).click();
  await page.getByRole("button",{name:"Back to check 1"}).click();
  await expect(select).toHaveValue("0");
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.setViewportSize({width:1440,height:1000});
  await checks.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:path.join(out,"measurements.png")});
  // Keep the saved shop record untouched while exercising failed writes from both ends of the page.
  const saveURL = "**/api/sketch-conversions/"+sketch.drawing_id+"/review";
  const attempts = [];
  await page.route(saveURL, async route => {
    attempts.push(route.request().postDataJSON());
    await route.fulfill({status:409,json:{error:"A newer revision is available. Reopen it before saving."}});
  });
  await select.selectOption(String(idx));
  await input.fill("1/4");
  const footer = page.locator("#sketch-signoff");
  await footer.getByRole("button",{name:"Confirm and make files"}).click();
  await expect(footer.getByRole("alert")).toContainText("A newer revision");
  await footer.getByRole("button",{name:"Save and check"}).click();
  await page.getByRole("button",{name:"Save this review"}).click();
  await expect.poll(() => attempts.map(a => a.confirmed)).toEqual([true,false,false]);
  await expect(input).toHaveValue("1/4");
  const engineering = sketch.solution.pins.findIndex(p => p.code==="engineering_note" && p.review_key);
  if(engineering>=0){
    await select.selectOption(String(engineering));
    await checks.getByRole("checkbox").check();
    await footer.getByRole("button",{name:"Confirm and make files"}).click();
    await expect(footer.getByRole("alert")).toContainText("approved drawing reference");
    await expect(footer.getByRole("textbox")).toBeFocused();
    assert.equal(attempts.length,3);
  }
  await page.unroute(saveURL);
  const latest = (await api("/api/blueprints/jobs")).find(row => row.state === "review_required" && /awning/i.test(row.drawing.filename));
  assert.ok(latest,"Requires a saved awning estimate.");
  await page.goto(new URL("/blueprints/"+latest.id,base).href);
  const steps = page.getByLabel("Quote setup step",{exact:true});
  await steps.selectOption("specs");
  const partPicker = page.getByLabel("Part to review",{exact:true});
  const tube = partPicker.locator("option").filter({hasText:/framing tubes|support tubes/i}).first();
  await partPicker.selectOption(await tube.getAttribute("value"));
  const spec = page.locator("#confirm-drawing-specs");
  await expect(spec.locator(".bp-known")).toContainText("0.25 in thick");
  await expect(spec.getByLabel("Quantity",{exact:true})).toBeVisible();
  await spec.getByLabel("Quantity",{exact:true}).fill("7");
  await steps.selectOption("cost");
  await expect(page.getByLabel("Cost item",{exact:true})).toBeVisible();
  await steps.selectOption("specs");
  await expect(spec.getByLabel("Quantity",{exact:true})).toHaveValue("7");
  await page.getByRole("tab",{name:"Check the drawing"}).click();
  await page.getByLabel("Type of drawing check",{exact:true}).selectOption("uncertain");
  await expect(page.locator("#uncertain-ai-readings .bp-check-items > li")).toHaveCount(1);
  await page.getByRole("tab",{name:"What the AI found"}).click();
  await page.getByRole("button",{name:"Enter order quantity",exact:true}).first().click();
  await expect(spec).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({animations:"disabled",path:path.join(out,"quote-setup.png")});
  await page.setViewportSize({width:1440,height:1000});
  const summary = await api("/api/quotes");
  let quote;
  for (const item of summary) {
    const candidate = await api("/api/quotes/"+item.id);
    if(candidate.items.length>6 && candidate.items.some(line=>!line.costRows.length)) {quote=candidate;break;}
  }
  assert.ok(quote,"Requires a saved multi-part quote with unpriced work.");
  await page.goto(new URL("/quotes/"+quote.id,base).href);
  const parts = page.locator(".qe-part-group:visible");
  await expect(parts).toHaveCount(6);
  await page.getByRole("button",{name:"Next parts"}).click();
  await expect(parts.first()).toHaveAttribute("id","part-"+quote.items[6].id);
  await page.getByRole("button",{name:/Missing costs/}).click();
  await expect(parts).toHaveCount(Math.min(6,quote.items.filter(row=>!row.costRows.length).length));
  await page.getByRole("searchbox",{name:"Find a part or service"}).fill("No matching part 991793");
  await expect(page.getByText("No parts match this view.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Show all parts",exact:true}).click();
  await expect(parts).toHaveCount(6);
  await page.getByRole("heading",{level:1}).scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:path.join(out,"estimate.png")});
  await page.getByText("Ask AI",{exact:true}).click();
  let reply;
  await page.route("**/api/assistant",route=>{reply=route;});
  const composer=page.getByRole("textbox",{name:"Your instruction"});
  await composer.fill("Which part needs a price?");
  await composer.press("Enter");
  await expect(page.locator(".chat-thinking")).toBeVisible();
  await expect(page.getByRole("button",{name:"Send",exact:true})).toBeDisabled();
  await expect.poll(()=>Boolean(reply)).toBe(true);
  await composer.fill("Next question");
  await reply.fulfill({json:{answer:"**Check the part quantity.**\n\n- Verify the order quantity.\n- Compare the material callout.",checks:[],draft:quote,
    changes:[{label:"Order quantity",before:"1",after:"2",evidence:"Test suggestion"}],changedPaths:["items.0.quantity"]}});
  await expect(page.getByRole("log").getByText("Check the part quantity.",{exact:true})).toBeVisible();
  await expect(page.getByRole("log").getByRole("listitem")).toHaveCount(2);
  await expect(composer).toHaveValue("Next question");
  await expect(page.locator(".chat-thinking")).toHaveCount(0);
  const apply = page.getByRole("button",{name:"Apply suggested changes"});
  await expect(apply).toBeEnabled();
  await page.locator(".qe-customer>summary").click();
  await page.getByLabel("Job name",{exact:true}).fill("Unsaved interface check");
  await expect(apply).toBeDisabled();
  await page.getByRole("button",{name:"Dismiss",exact:true}).click();
  await page.getByLabel("Job name",{exact:true}).fill(quote.jobName);
  await composer.scrollIntoViewIfNeeded();
  await page.screenshot({animations:"disabled",path:path.join(out,"assistant.png")});
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:"reduce"});
  await expect(composer).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await composer.press("Enter");
  await expect(page.locator(".chat-thinking")).toBeVisible();
  assert.ok(await page.locator(".chat-thinking i").first().evaluate(el=>parseFloat(getComputedStyle(el).animationDuration)<.01));
  await expect.poll(()=>reply?.request().postDataJSON().instruction).toBe("Next question");
  await reply.fulfill({status:503,json:{error:"Reader unavailable. Try again."}});
  await expect(page.getByRole("alert").filter({hasText:"Reader unavailable"})).toBeVisible();
  await expect(composer).toHaveValue("Next question");
  assert.deepEqual(errors,[]);
  console.log("Verified both sketch save actions and inline errors, retained answers, the awning scope and specification steps, inventory links, estimate filters, phone layout, chat and reduced motion.");
  console.log(out);
} finally { await browser.close(); }
