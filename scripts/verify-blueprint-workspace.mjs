// Run after tests.blueprint_flow populated the isolated engineering stack.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = parseEnv(
  await readFile(path.join(root, ".env.nfip-test"), "utf8"),
);
assert.equal(config.NFIP_API_URL, "http://127.0.0.1:8141");
await mkdir(path.join(root, ".test-results"), { recursive: true });
const dir = await mkdtemp(path.join(root, ".test-results", "blueprint-ui-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const base = "http://127.0.0.1:" + port;
const server = spawn(
  process.execPath,
  [
    path.join(root, "scripts/web.mjs"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      LMM_DATA_DIR: dir,
      LMM_SUPABASE_DATA_DIR: path.join(dir, "unconnected"),
      NFIP_ARCHIVE_DATA_DIR: dir,
      NFIP_ARCHIVE_ENV: ".env.nfip-test",
      NFIP_API_URL: config.NFIP_API_URL,
      NFIP_API_TOKEN: config.NFIP_API_TOKEN,
    },
  },
);
let browser;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/blueprints/settings")).ok) break;
    } catch {}
    await delay(250);
  }
  const executablePath =
    process.env.CHROME_PATH ||
    [
      path.join(
        process.env.PROGRAMFILES || "",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "",
        "Microsoft/Edge/Application/msedge.exe",
      ),
      "/usr/bin/chromium",
    ].find(existsSync);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/");
  await page
    .getByRole("link", { name: "Drawing reviews", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Add a drawing" }).click();
  await expect(
    page.getByRole("heading", { name: "Start from a drawing" }),
  ).toBeVisible();
  await expect(
    page.locator(".bp-tag", { hasText: "Demo shop rates" }),
  ).toBeVisible();
  const jobs = await (await fetch(base + "/api/blueprints/jobs")).json();
  const ready = jobs.find(
    (j) =>
      j.state === "ready" && j.customer_name === "Blueprint acceptance fixture" && j.drawing.type === "CUSTOMER_PDF",
  );
  assert.ok(ready, "Run python -m tests.blueprint_flow on the test API first.");
  await page.goto(base + "/blueprints/" + ready.id);
  await expect(
    page.getByRole("heading", { name: "Ready to quote" }),
  ).toBeVisible();
  const selected = await (await fetch(base + "/api/blueprints/jobs/" + ready.id)).json();
  const exampleCitation = selected.result.lines.flatMap(line => line.history)[0]?.citation.excerpt;
  assert.ok(exampleCitation, "Expected a comparable example in the test ledger");
  for (const summary of await page.locator(".bp-part-pricing > details > summary").all()) await summary.click();
  await expect(page.getByText(exampleCitation, {exact:true}).first()).toBeVisible();
  await expect(page.getByText(/P2-TRAINING-MARGIN v1/).first()).toBeVisible();
  const open = page.getByRole("button", { name: "Open editable quote draft" });
  await open.click();
  await page.waitForURL(/\/quotes\/[a-f0-9-]+$/, { timeout: 30000 });
  const draftUrl = page.url();
  await page.goto(base + "/blueprints/" + ready.id);
  await open.click();
  await page.waitForURL(draftUrl);
  await page.getByRole("link",{name:"View drawing and original estimate"}).click();
  await expect(page.getByRole("heading",{name:"Original estimate"})).toBeVisible();
  await page.getByRole("button",{name:"Next page"}).click();
  await expect(page.getByRole("img",{name:"Drawing preview, page 2"})).toBeVisible();
  const reuse = process.argv.includes("--reopen-fixture");
  if (reuse) {
    const fixture = jobs.find(j => j.job_name.startsWith("Browser fixture ") && j.state === "ready");
    assert.ok(fixture, "No saved browser fixture is ready.");
    await page.goto(base + "/blueprints/" + fixture.id);
  } else {
    await page.goto(base + "/blueprints");
    await page.getByRole("button", { name: "Add a drawing" }).click();
    const unique = "Browser fixture " + Date.now();
    await page.locator("input[type=file]").setInputFiles(path.join(root, "packages/ai/examples/fixture-plate-set.pdf"));
    await page.getByLabel("Job name", { exact: false }).fill(unique);
    await page.getByRole("button", { name: "Read drawing and estimate" }).click();
    await page.waitForURL(/\/blueprints\/[a-f0-9-]+$/, { timeout: 30000 });
    await page.reload();
    await expect(page.getByRole("heading", { name: unique })).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: /Ready to quote|Ready for a budget draft/ }),
  ).toBeVisible({ timeout: 320000 });
  const id = page.url().split("/").at(-1);
  let job = await (await fetch(base + "/api/blueprints/jobs/" + id)).json();
  assert.equal(job.ast.parts.length, 2);
  assert.ok(job.drawing.sha256);
  const liveState = job.state;
  if (job.state !== "ready") {
    await page.getByRole("button", {name:"Open quote draft"}).click();
    await page.waitForURL(/\/quotes\/[a-f0-9-]+$/);
    await page.goto(base + "/blueprints/" + ready.id);
    job = await (await fetch(base + "/api/blueprints/jobs/" + ready.id)).json();
  }
  {
    await page.getByText("Review drawing details or adjust rates",{exact:true}).click();
    await page.getByRole("tab",{name:"Check the drawing"}).click();
    await page.getByRole("combobox",{name:"Type of drawing check",exact:true}).selectOption("tools");
    await page.getByText("All specifications and feature editing",{exact:true}).click();
    const original = job.ast.parts[0].quantity;
    const part = page.locator(".bp-form summary").filter({hasText:new RegExp("^" + job.ast.parts[0].part_id + "$")}).first().locator("xpath=..");
    await expect(part.getByRole("button", {name:"Add a hole or slot"})).toBeVisible();
    await expect(page.getByRole("button",{name:"Save review and calculate price"})).toBeVisible();
    if (!reuse) {
    await page.getByLabel("Quantity",{exact:true}).first().fill(String(original+1));
    await part.getByRole("button", {name:"Add a hole or slot"}).click();
    const lastIndex = job.ast.parts[0].holes.length;
    const opening = part.locator("summary").filter({hasText:new RegExp("^Opening " + (lastIndex + 1) + "$")}).first().locator("xpath=..");
    await opening.locator("summary").click();
    await opening.locator("label").filter({hasText:/^Shape/}).locator("select").selectOption("round");
    await opening.getByLabel("How the opening is made").selectOption("cut");
    await opening.getByLabel("Hole center X (in)").fill("1");
    await opening.getByLabel("Hole center Y (in)").fill("1");
    await opening.getByLabel("Diameter in", {exact:true}).fill("0.5");
    await page.getByLabel("What did you check or correct?").fill("Customer confirmed one extra fixture plate.");
    await page.getByLabel(/I confirmed the inputs used to calculate this estimate/).check();
    const submission=page.waitForResponse(r=>r.url().endsWith("/review") && r.request().method()==="POST");
    await page.getByRole("button",{name:"Save review and calculate price"}).click();
    const saved=await submission;
    assert.equal(saved.status(),202,await saved.text());
    await expect.poll(async()=>{
      const revised=await (await fetch(base+"/api/blueprints/jobs/"+job.id)).json();
      return [revised.state,revised.version,revised.ast.parts[0].quantity,revised.original_ast.parts[0].quantity,revised.ast.parts[0].holes[lastIndex]?.diameter_in,revised.original_ast.parts[0].holes.length];
    },{timeout:60000}).toEqual(["ready",job.version+1,original+1,original,0.5,lastIndex]);
    await page.reload();
    await expect(page.getByRole("heading",{name:"Ready to quote"})).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
    true,
    "Mobile content overflows",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Chrome verified " + (reuse ? "reopening the live two-part reading (" : "PDF upload and reload, two-part live extraction (") +
      liveState +
      "), source, rule and historical citations, " + (reuse ? "advanced editing controls" : "adding a missing opening") +
      ", an editable draft, idempotent reopen and mobile layout.",
  );
} finally {
  await browser?.close();
  server.kill();
}
