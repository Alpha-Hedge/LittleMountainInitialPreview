import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

const base = "http://127.0.0.1:3143",
  output = path.resolve(".test-results");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(path.join(output, "quote-desk-"));
const next = fileURLToPath(new URL("./web.mjs", import.meta.url));
const server = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", "3143"], {
  env: { ...process.env, LMM_DATA_DIR: folder },
  stdio: "ignore",
  windowsHide: true,
});
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw Error("The isolated desk server exited.");
    try {
      if ((await fetch(base + "/api/quotes")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(250);
  }
  assert.ok(ready);
  const executablePath =
    process.env.CHROME_PATH ||
    [
      path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((p) => existsSync(p));
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await expect(page.getByRole("heading", { name: "Quote desk", exact: true })).toBeVisible();
  const start = page.getByRole("link", { name: "Start a quote", exact: true });
  await start.click();
  await expect(page.getByLabel(/Drawing or photo/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Read drawing & start quote" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Customer name", exact: true })).toBeHidden();
  await page.getByText("Start without a drawing", { exact: true }).click();
  await expect(page.locator(".qe-manual input:visible")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Customer name" }).fill("Fireside Welding");
  await page.getByRole("textbox", { name: "Job name" }).fill("Loading dock handrail");
  await page.getByRole("button", { name: "Save & add work" }).click();
  await expect(page.getByRole("heading", { name: "Parts & work" })).toBeVisible();
  const savedUrl = page.url();
  await page.goto(base);
  const search = page.getByRole("searchbox");
  await search.fill("DOCK fireside");
  const result = page.getByRole("link", { name: /Open Loading dock handrail for Fireside/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(savedUrl);
  await page.goto(base);
  await page.getByRole("button", { name: /^Approved/ }).click();
  await expect(page.getByRole("heading", { name: "No quotes match" })).toBeVisible();
  await page.getByRole("button", { name: "Show all quotes" }).click();
  await expect(result).toBeVisible();
  await page.screenshot({ path: path.join(folder, "desktop.png"), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(start).toBeVisible();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      "Home fits at " + width + "px",
    );
    if (width === 390) await page.screenshot({ path: path.join(folder, "phone.png"), fullPage: true });
    await page.locator(".shop-menu summary").click();
    await page
      .getByRole("navigation", { name: "Menu", exact: true })
      .getByRole("link", { name: "Quick guide" })
      .click();
    await expect(page.getByRole("heading", { name: "Quick guide", exact: true })).toBeVisible();
    await page.getByText("When do I choose a cost for each piece?").click();
    await expect(page.getByText(/With 10 parts, the shop cost is/)).toBeVisible();
    await page.getByRole("link", { name: "Find a saved quote" }).click();
  }
  await page.setViewportSize({width: 1280, height: 900});
  const estimateUrl = base + "/quotes/demo-mounting-plate/estimate";
  await page.goto(estimateUrl);
  const openRouting = page.getByRole("button", {name: "Calculate sheet stock and work-center time"});
  await openRouting.click();
  const routing = page.getByRole("dialog", { name: "Sheet stock and work centers" });
  for (const [label, value] of Object.entries({
    "Stock width (mm)":100, "Stock length (mm)":100, "Blank width (mm)":50, "Blank length (mm)":50,
    "Edge margin on all sides (mm)":0, "Clear gap between blanks (mm)":0, "Purchase cost per sheet ($)":50,
  })) await routing.getByLabel(label, {exact:true}).fill(String(value));
  await routing.getByRole("button", { name:"Add operation" }).click();
  await routing.getByLabel("Work center or operation").fill("Brake");
  await routing.getByLabel("Production unit").selectOption("bend");
  await routing.getByLabel("Units per piece (bend)").fill("2");
  await routing.getByLabel("Throughput (bend per hour)").fill("10");
  await routing.getByLabel("Setup per batch (minutes)").fill("30");
  await routing.getByLabel("Work-center cost ($/hour)").fill("60");
  await routing.getByRole("button", {name:"Calculate routing",exact:true}).click();
  await expect(routing.locator(".routing-total")).toContainText("$300.00", {timeout:30000});
  await routing.getByRole("button", {name:"Save routing costs to quote"}).click();
  await expect(page).toHaveURL(base+"/quotes/demo-mounting-plate",{timeout:30000});
  await page.goto(estimateUrl);
  await openRouting.click();
  await expect(routing.getByLabel("Purchase cost per sheet ($)")).toHaveValue("50");
  await routing.getByLabel("Work-center cost ($/hour)").fill("80");
  await routing.getByRole("button", {name:"Calculate routing",exact:true}).click();
  await expect(routing.locator(".routing-total")).toContainText("$350.00", {timeout:30000});
  await expect(routing.getByRole("button", {name:"Save routing costs to quote"})).toBeDisabled();
  await routing.screenshot({path:path.join(folder, "routing-revision.png")});
  await routing.getByLabel("Replace the previously saved routing costs for this item.").check();
  await routing.getByRole("button", {name:"Save routing costs to quote"}).click();
  await expect(page).toHaveURL(base+"/quotes/demo-mounting-plate",{timeout:30000});
  await page.goto(estimateUrl);
  await openRouting.click();
  await expect(routing.getByLabel("Work-center cost ($/hour)")).toHaveValue("80");
  await page.goto(estimateUrl + "?version=2");
  await page.getByText("See the costs saved with this quote", {exact:true}).click();
  await page.getByText("Stock and work-center inputs · version 2", {exact:true}).click();
  await expect(page.locator(".routing-basis")).toContainText("$60.00 per hour");
  await expect(page.locator(".routing-basis")).toContainText("$300.00");
  await page.goto(base+"/settings");
  const profiles = page.getByRole("group",{name:"Pricing profiles"});
  await profiles.getByRole("button",{name:"U.S. practice rates",exact:true}).click();
  await page.getByRole("searchbox",{name:"Find a rate"}).fill("316L");
  await expect(page.getByRole("button",{name:/316L stainless steel/})).toHaveCount(2);
  await page.getByRole("combobox",{name:"Category",exact:true}).selectOption("Finishing");
  await expect(page.getByText("No rates match these filters.")).toBeVisible();
  await page.getByRole("searchbox",{name:"Find a rate"}).fill("powder");
  await expect(page.getByRole("button",{name:/Powder coating/})).toBeVisible();
  await profiles.getByRole("button",{name:"My shop rates",exact:true}).click();
  await expect(page.getByText("Add your first price to start the shop rate book.")).toBeVisible();
  await page.getByRole("button",{name:"Add hourly rate"}).click();
  await page.getByRole("textbox",{name:"Price name",exact:true}).fill("Nick’s production welding");
  await page.getByRole("spinbutton",{name:"Price per hour ($)",exact:true}).fill("93");
  await page.getByRole("textbox",{name:"Where did this price come from?"}).fill("Test shop cost sheet");
  await page.getByRole("textbox",{name:"What does it cover?"}).fill("One shop welder and overhead");
  await page.getByRole("combobox",{name:"Use for drawing budgets (optional)"}).selectOption("weld");
  await page.getByRole("button",{name:"Save price",exact:true}).click();
  await expect(page.getByText("Shop prices saved.")).toBeVisible();
  await page.getByRole("button",{name:"Use my shop rates",exact:true}).click();
  await expect(page.getByText("New estimates now use your shop rates.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button",{name:/Nick’s production welding/})).toBeVisible();
  await page.goto(estimateUrl);
  await expect(page.getByRole("heading",{name:"Add a job type to start"})).toBeVisible();
  await page.goto(base+"/settings");
  await profiles.getByRole("button",{name:"U.S. practice rates",exact:true}).click();
  await page.getByRole("button",{name:"Use practice rates",exact:true}).click();
  await expect(page.getByText("New estimates now use U.S. practice rates.")).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:path.join(folder,"practice-rates.png")});
  assert.deepEqual(errors, []);
  console.log(
    "Verified quote desk search and navigation, create/reopen, mobile guide, and sheet/work-center pricing including revision confirmation.",
  );
  console.log(folder);
} finally {
  await browser?.close();
  server.kill();
}
