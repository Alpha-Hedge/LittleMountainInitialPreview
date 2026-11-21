import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";
import { chromium, expect } from "@playwright/test";

const output = path.resolve(process.argv[2]);
const priorRun = process.argv[3] ? path.resolve(process.argv[3]) : null;
const cases = JSON.parse(await readFile(path.join(output, "cases.json"), "utf8"));
const config = parseEnv(await readFile(".env.nfip-test", "utf8"));
assert.equal(config.NFIP_API_URL, "http://127.0.0.1:8141");
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const desk = "http://127.0.0.1:" + port;
const isolated = path.join(output, "desk");
await mkdir(isolated);
const server = spawn(process.execPath, ["scripts/web.mjs", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  windowsHide: true, stdio: "ignore",
  env: {
    ...process.env, LMM_DATA_DIR: isolated, NFIP_ARCHIVE_DATA_DIR: isolated,
    NFIP_ARCHIVE_ENV: ".env.nfip-test", LMM_SUPABASE_DATA_DIR: path.join(isolated, "unconnected"),
    LMM_SUPABASE_WORKSPACE_KIND: "verification", LMM_GMAIL_CLIENT_ID: "", LMM_GMAIL_CLIENT_SECRET: "",
    NFIP_API_URL: config.NFIP_API_URL, NFIP_API_TOKEN: config.NFIP_API_TOKEN,
  },
});
const chrome = process.env.CHROME_PATH || [
  path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
  "/usr/bin/chromium", "/usr/bin/google-chrome",
].find(existsSync);
let browser;
async function save(index, record) {
  await writeFile(path.join(output, "browser-" + index + ".json"), JSON.stringify(record, null, 2));
}

async function askAboutOriginal(page, text) {
  const drawingTab = page.getByRole("tab", {name:"Check the drawing"});
  if (await drawingTab.count()) await drawingTab.click();
  const assistant = page.getByText("Ask AI", { exact: true });
  if (!await assistant.evaluate(summary => summary.parentElement.open)) await assistant.click();
  await page.getByLabel("Your instruction").fill(text);
  await page.getByLabel(/Look at the (drawing|photo)/).check();
  const start = performance.now();
  const reply = page.waitForResponse(r => new URL(r.url()).pathname === "/api/assistant", { timeout: 150_000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await reply;
  const result = await response.json();
  assert.ok(response.ok(), result.error);
  await expect(page.getByLabel("Assistant conversation")).toContainText(result.answer);
  return { seconds: Math.round((performance.now() - start) / 100) / 10, ...result };
}

async function exerciseOriginal(page, index, spec, job) {
  const record = {};
  async function check(name, operation) {
    try { record[name] = { status: "PASS", detail: await operation() }; }
    catch (error) { record[name] = { status: "FAIL", detail: error.message }; }
  }
  const original = await readFile(spec.path);
  if (spec.sketch) {
    await check("Sketch checklist and marker toggle", async () => {
      const markers = page.getByRole("button", { name: /^Go to check / });
      await expect(markers).toHaveCount(0);
      const advanced = page.getByRole("region", { name: "Interactive drawing review" });
      await expect(advanced).toHaveCount(0);
      const engineering = job.solution.pins.findIndex(pin=>pin.code==="engineering_note");
      assert.ok(engineering >= 0);
      await page.getByLabel("Jump to a check").selectOption(String(engineering));
      await expect(page.getByRole("heading",{name:"Confirm the engineering reference"})).toBeVisible();
      await page.getByRole("button", { name: "Show check markers on photo" }).click();
      await expect(markers.first()).toBeVisible();
      await page.getByRole("button", { name: "Hide check markers" }).click();
      await expect(markers).toHaveCount(0);
      const preview = page.getByText("Inspect AI readings and drawing preview", {exact:true});
      await preview.click();
      await expect(advanced).toBeVisible();
      await preview.click();
      await expect(advanced).toHaveCount(0);
      return "Engineering check is visible, and the photo starts clean. Both kinds of markers are available on demand.";
    });
    await check("Ask AI on the handwritten photo", async () => {
      const result = await askAboutOriginal(page, "Read the original photo and report the written mounting-plate size, hole diameter, number of holes and spacing. What does the note say about engineering and thickness? Answer only and leave all inputs as they are.");
      assert.equal(result.draft, null);
      const repeat = await askAboutOriginal(page, "What handwritten note says the thickness might change? Answer only.");
      assert.equal(repeat.draft, null);
      assert.match(repeat.answer, /thick/i);
      assert.equal((await (await fetch(desk + "/api/sketch-conversions/" + job.drawing_id)).json()).version, job.version);
      return { seconds: result.seconds, answer: result.answer, followUpSeconds: repeat.seconds };
    });
  } else if (job.ast?.source_release_hold) {
    if (process.env.LMM_REAL_ASSISTANT_AUDIT === "1") await check("Ask AI on the awning sheet", async () => {
      const result = await askAboutOriginal(page, "Read this sheet. Summarize the issue stamp, the steel angle, tubing and gutter callouts, and what information is missing for the metal shop to price and release this job. Answer only.");
      assert.equal(result.draft, null);
      return { seconds: result.seconds, answer: result.answer };
    });
    await check("Prepared quote draft", async () => {
      await page.getByRole("button", { name: "Open quote draft" }).click();
      await page.waitForURL(/\/quotes\/[0-9a-f-]+$/, { timeout: 30_000 });
      const url = page.url();
      const api = desk + "/api" + new URL(url).pathname;
      const quote = await (await page.request.get(api)).json();
      assert.match(quote.notes, /Drawing scope to check/);
      const href = await page.getByRole("link", { name: "Open original drawing in a new tab" }).getAttribute("href");
      const file = await page.request.get(desk + href);
      assert.deepEqual(await file.body(), original);
      await page.reload();
      await expect(page.getByRole("link", { name: "Open original drawing in a new tab" })).toBeVisible();
      const review = await (await page.request.get(api + "/approval")).json();
      const rejected = await page.request.post(api + "/approval", {
        data: { action: "submit", version: quote.version, drawingId: review.snapshot.drawing.id, details: review.snapshot.details },
      });
      const message = (await rejected.json()).error;
      assert.ok([400,409].includes(rejected.status()), message);
      assert.match(message, /confirmed cost|confirm the order quantities/i);
      return { quote: quote.number, carriedOver: quote.items.map(line => ({ description: line.description, quantity: line.quantity })),
        cost: quote.totals.estimatedCost, approval: message };
    });
    await check("Save an incomplete blueprint review", async () => {
      const jobPath = "/blueprints/" + job.id;
      await page.goto(desk + jobPath);
      await page.getByLabel("Quote setup step",{exact:true}).selectOption("specs");
      const missing = job.flags.find(flag => flag.kind === "missing" && /^parts\.\d+\.quantity$/.test(flag.path));
      assert.ok(missing);
      await page.getByLabel("Part to review",{exact:true}).selectOption(missing.path.split(".")[1]);
      const group = page.locator("#confirm-drawing-specs");
      await group.getByLabel("Quantity", { exact: true }).first().fill("3");
      const jobEndpoint = "/api/blueprints/jobs/" + job.id;
      const saveRequest = page.waitForResponse(r => new URL(r.url()).pathname === jobEndpoint + "/review", { timeout: 30000 });
      await page.getByRole("button", { name: "Save progress", exact: true }).click();
      const saved = await saveRequest;
      assert.ok(saved.ok(), await saved.text());
      const reopened = await (await page.request.get(desk + jobEndpoint)).json();
      assert.equal(reopened.version, job.version + 1);
      assert.equal(reopened.state, "review_required");
      assert.ok(reopened.ast.parts.some(part => part.quantity === 3));
      assert.ok(reopened.flags.length > 0);
      await expect(page.getByText("Progress saved", {exact:true})).toBeVisible();
      await page.reload();
      await expect(page.getByRole("tab", {name:"Quote setup"})).toBeVisible();
      return { version: reopened.version, remainingChecks: reopened.flags.length };
    });
    if (process.env.LMM_REAL_SOURCE_SCOPE_AUDIT === "1" && job.drawing.filename === "2208_AWNING-A6.7.pdf") {
      await check("Printed copper callouts and Nick’s scope decisions", async () => {
        const jobPath = "/blueprints/" + job.id;
        const api = desk + "/api/blueprints/jobs/" + job.id;
        const record = async () => (await page.request.get(api)).json();
        await page.goto(desk + jobPath);
        await expect(page.getByRole("heading", {name:"What goes into the quote?"})).toBeVisible();
        await expect(page.getByLabel("Quote setup step",{exact:true})).toHaveValue("scope");
        let current = await record();
        if (!current.printed_inventory_current) {
          await page.getByRole("tab", {name:"Check the drawing"}).click();
          const response = page.waitForResponse(r => r.url() === api + "/source-check");
          await page.getByRole("button",{name:"Fill from printed callouts"}).click();
          assert.ok((await response).ok());
          await page.reload();
          current = await record();
        }
        assert.equal(current.printed_inventory_current, true);
        for (const label of [/maine deck bracket/i, /metal furring strips/i, /lighting fixture/i]) {
          const part = current.source_callouts.find(row => label.test(row.label));
          assert.ok(part?.part_id, "Printed source check missed " + label);
          assert.equal(part.page,1);
        }
        const copperDrip = current.source_callouts.find(row => /^copper drip$/i.test(row.label));
        if (copperDrip?.status === "recovered" && !current.scope_decisions?.[copperDrip.part_id]) {
          const part = current.ast.parts.find(part => part.part_id === copperDrip.part_id);
          assert.equal(part?.material_family, "copper");
          assert.equal(part?.quantity, null);
          await page.getByRole("tab", {name:"What the AI found"}).click();
          const inventory = page.getByRole("region", {name:"What the AI found"});
          const filled = inventory.getByText(/^Automatically filled with source evidence/);
          await filled.click();
          const list = filled.locator("xpath=..");
          await expect(list.getByText(/COPPER DRIP · Material family/)).toBeVisible();
          await expect(list.getByRole("link",{name:"Page 1"}).first()).toBeVisible();
        }
        const gutter = current.source_callouts.find(row => /copper half.round gutter/i.test(row.label));
        const downspout = current.source_callouts.find(row => /copper downspout/i.test(row.label));
        assert.ok(gutter?.part_id && downspout?.part_id, "The original copper callouts must have linked part records.");
        assert.equal(gutter.page,1);
        assert.equal(downspout.page,1);
        if (gutter.status !== "recovered" || downspout.status !== "recovered") {
          return {text:"Both printed items are linked to the saved parts list.",gutter:gutter.status,downspout:downspout.status};
        }
        const lane = page.locator("#nick-recovered-scope");
        await page.getByRole("tab", {name:"Quote setup"}).click();
        await lane.getByLabel("Extra item",{exact:true}).selectOption(gutter.part_id);
        await lane.getByRole("button",{name:"Our shop supplies it"}).click();
        await lane.getByLabel("Extra item",{exact:true}).selectOption(downspout.part_id);
        await lane.getByRole("button",{name:"Leave it out"}).click();
        const note = "Steel awning and copper gutter. Downspout supplied by others.";
        await page.getByLabel("Scope note (optional)").fill(note);
        await page.getByRole("region", {name:"What goes into the quote?"}).getByRole("combobox", {name:/Installation/}).selectOption("excluded");
        const saved = page.waitForResponse(r => r.url() === api + "/review");
        await page.getByRole("button",{name:"Save progress",exact:true}).click();
        assert.ok((await saved).ok());
        const reopened = await record();
        assert.equal(reopened.shop_scope,note);
        assert.equal(reopened.scope_decisions[gutter.part_id],"include");
        assert.equal(reopened.scope_decisions[downspout.part_id],"exclude");
        assert.equal(reopened.installation,"excluded");
        assert.ok(reopened.ast.parts.some(part => part.part_id === gutter.part_id));
        assert.ok(!reopened.ast.parts.some(part => part.part_id === downspout.part_id));
        await page.reload();
        await expect(page.getByLabel("Scope note (optional)")).toHaveValue(note);
        await page.getByRole("button",{name:"Open quote draft"}).click();
        await page.waitForURL(/\/quotes\/[0-9a-f-]+$/);
        const draft = await (await page.request.get(desk + "/api" + new URL(page.url()).pathname)).json();
        assert.match(draft.notes,/Outside shop scope:.*copper downspout/i);
        assert.match(draft.notes,/Installation: excluded/);
        const approval = await (await page.request.get(desk + "/api" + new URL(page.url()).pathname + "/approval")).json();
        assert.match(approval.snapshot.details.scope,/Downspout supplied by others/);
        assert.equal(approval.snapshot.details.scopeConfirmed,false);
        await page.goto(desk + jobPath);
        const reopenedLane = page.locator("#nick-recovered-scope");
        await reopenedLane.getByLabel("Extra item",{exact:true}).selectOption(downspout.part_id);
        await expect(reopenedLane.getByRole("button",{name:"Leave it out"})).toHaveAttribute("aria-pressed","true");
        await reopenedLane.getByRole("button",{name:"Our shop supplies it"}).click();
        const restored = page.waitForResponse(r => r.url() === api + "/review");
        await page.getByRole("button",{name:"Save progress",exact:true}).click();
        assert.ok((await restored).ok());
        const latest = await record();
        assert.ok(latest.ast.parts.some(part => part.part_id === downspout.part_id && part.quantity == null));
        return {text:"Both printed copper callouts were recovered. Scope, exclusions and installation survived reopen and carried to the quote. Restoring an excluded item left its quantity open.",gutter:gutter.evidence,downspout:downspout.evidence};
      });
    }
  }
  await writeFile(path.join(output, "assistant-" + index + ".json"), JSON.stringify(record, null, 2));
}

async function checkRegularQuoteIntake() {
  const spec = cases.find(item => path.basename(item.path) === "2208_AWNING-A6.7.pdf");
  if (!spec) return;
  const page = await browser.newPage();
  const start = performance.now();
  const response = await page.request.post(desk + "/api/quotes/from-drawing", {
    multipart: { token: crypto.randomUUID(), file: { name: path.basename(spec.path),
      mimeType: "application/pdf", buffer: await readFile(spec.path) } },
  });
  assert.ok(response.ok(), await response.text());
  const { quoteId, revisionId } = await response.json();
  const api = desk + "/api/quotes/" + quoteId;
  const draft = await (await page.request.get(api)).json();
  const line = { id: "internal-test", description: "QA allowance", quantity: 1,
    costRows: [{ id: "allowance", label: "Test budget allowance", basis: "batch", amount: 1, rate: 100 }] };
  const edit = await page.request.put(api, {
    data: { ...draft, customer: "Isolated review test", jobName: "Awning hold verification", items: [line] },
  });
  assert.ok(edit.ok(), await edit.text());
  const revised = await edit.json();
  const approval = await (await page.request.get(api + "/approval")).json();
  const submit = await page.request.post(api + "/approval", { data: {
    action: "submit", version: revised.version, drawingId: revisionId,
    details: { ...approval.snapshot.details, scope: "Internal test allowance", scopeConfirmed: true,
      leadTime: "Two weeks", leadTimeConfirmed: true, terms: "Net 30",
      lineDescriptions: { [line.id]: line.description }, pricingDecision: { kind: "standard", reason: "Isolated gate test" } },
  } });
  const result = await submit.json();
  await writeFile(path.join(output, "ordinary-intake-hold.json"), JSON.stringify({
    status: submit.status(), workflow: result.status, error: result.error,
    proceeded: submit.ok() && result.status === "awaiting_review",
    seconds: Math.round((performance.now() - start) / 100) / 10,
  }, null, 2));
  await page.close();
}
try {
  await expect.poll(async () => {
    try { return (await fetch(desk + "/api/blueprints/settings")).status; } catch { return 0; }
  }, {timeout: 30_000}).toBe(200);
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  if (process.env.LMM_REAL_INTAKE_GATE_AUDIT === "1") {
    await checkRegularQuoteIntake();
  }
  const pages = [];
  for (const [index, spec] of cases.entries()) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const endpoint = spec.sketch ? "/api/sketch-conversions" : "/api/blueprints/jobs";
      if (priorRun) {
        const receipt = JSON.parse(await readFile(path.join(priorRun, "browser-" + index + ".json"), "utf8"));
        assert.ok(receipt.id, "The earlier upload has no saved drawing ID.");
        await page.goto(desk + (spec.sketch ? "/sketches/photo/" : "/blueprints/") + receipt.id);
        pages.push({ page, index, spec, errors, id: receipt.id, endpoint });
        continue;
      }
      const fromHome = !spec.sketch && path.extname(spec.path).toLowerCase() === ".pdf" && process.env.LMM_REAL_HOME_START === "1";
      await page.goto(desk + (fromHome ? "/" : spec.sketch ? "/sketches" : "/blueprints"));
      if (fromHome) await page.getByRole("link", { name: "Start a quote", exact: true }).click();
      if (!spec.sketch && !fromHome) await page.getByRole("button", { name: "Add a drawing" }).click();
      await page.locator("input[type=file]").first().setInputFiles(spec.path);
      if (!spec.sketch && !fromHome) await page.getByLabel("Job name", { exact: false }).fill(path.basename(spec.path));
      const uploaded = page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === "POST");
      await page.getByRole("button", { name: spec.sketch ? "Upload & read sketch" : fromHome ? "Read drawing & start quote" : "Read drawing and estimate" }).click();
      const reply = await uploaded;
      if (!reply.ok()) throw Error("Upload returned " + reply.status() + ". " + await page.locator("#shop-content").innerText());
      await page.waitForURL(/\/(sketches\/photo|blueprints)\/[0-9a-f-]+$/, {timeout: 30_000});
      const id = new URL(page.url()).pathname.split("/").at(-1);
      pages.push({ page, index, spec, errors, id, endpoint });
      await save(index, { id, endpoint, upload: reply.status() });
    } catch (error) {
      await save(index, { error: error.message });
    }
  }
  await Promise.all(pages.map(async ({page, index, spec, errors, id, endpoint}) => {
    const states = new Set();
    const api = desk + endpoint + "/" + id;
    const reads = [];
    page.on("response", (r) => {
      if (r.url().split("?")[0] === api && r.request().method() === "GET") reads.push(r.status());
    });
    try {
      let job;
      const deadline = Date.now() + 540_000;
      while (Date.now() < deadline) {
        const response = await fetch(api);
        assert.ok(response.ok, "Polling returned " + response.status);
        job = await response.json();
        states.add(job.state);
        if (["needs_review", "review_required", "ready", "released", "failed"].includes(job.state)) break;
        await sleep(1500);
      }
      assert.ok(job && !["queued", "costing", "extracting", "reading"].includes(job.state), "Worker deadline elapsed.");
      assert.notEqual(job.state, "failed", job.error || "Worker failed");
      await page.reload();
      if (spec.sketch) {
        await page.getByRole("button",{name:"Review measurements",exact:true}).click();
        await expect(page.getByRole("img", {name: "Deskewed sketch with handwritten dimensions"})).toBeVisible();
        if (job.state === "needs_review") {
          await expect(page.getByRole("link", { name: /Full-size DXF/ })).toHaveCount(0);
          if (!priorRun || process.env.LMM_REAL_ASSEMBLY_AUDIT === "1") {
            await page.getByRole("button", {name:"Shop files",exact:true}).click();
            await page.getByText("Technical draft PDF",{exact:true}).click();
            const completed = page.waitForResponse(r => r.url() === api + "/draft", {timeout: 175_000});
            const download = page.waitForEvent("download", {timeout: 175_000});
            await page.getByRole("button", {name:"Download technical PDF", exact:true}).click();
            const draft = await download;
            if (process.env.LMM_REAL_ASSEMBLY_AUDIT === "1") {
              assert.equal((await completed).headers()["x-assembly-reference"], "complete");
            }
            assert.equal(draft.suggestedFilename(), "draft-drawing-rev-" + job.version + ".pdf");
            await draft.saveAs(path.join(output, "draft-" + index + ".pdf"));
            const bytes = await readFile(path.join(output, "draft-" + index + ".pdf"));
            assert.equal(bytes.subarray(0,5).toString(), "%PDF-");
            const reopened = await (await page.request.get(api)).json();
            assert.equal(reopened.state, "needs_review");
            assert.equal(reopened.version, job.version);
            await page.getByRole("button",{name:"Review measurements",exact:true}).click();
          }
        }
      } else {
        await expect(page.getByRole("heading", { name: job.state === "ready" ? "Ready to quote" : "Ready for a budget draft" })).toBeVisible();
        const inventory = page.getByRole("region", { name: "What the AI found" });
        if (job.state === "review_required") {
          const sections = page.getByRole("tablist", {name: "Drawing review"});
          await expect(sections.getByRole("tab")).toHaveCount(3);
          await expect(sections.getByRole("tab", {name:"Quote setup"})).toHaveAttribute("aria-selected", "true");
          await expect(page.getByLabel("Quote setup step",{exact:true})).toBeVisible();
          await expect(inventory).toBeHidden();
          await expect(page.getByRole("heading",{name:"Detailed calculation"})).toBeHidden();
        }
        if (job.state === "review_required" && (job.ast?.parts?.length || 0) > 6 && job.drawing.filename === "2208_AWNING-A6.7.pdf") {
          const sections = page.getByRole("tablist", {name:"Drawing review"});
          const shop = page.getByRole("region", {name: "What goes into the quote?"});
          await expect(shop.getByLabel("Scope note (optional)")).toBeVisible();
          const separate = page.locator("#nick-separate-pricing");
          await page.getByLabel("Quote setup step",{exact:true}).selectOption("cost");
          const channel = job.ast.parts.findIndex(part=>/C3\s*[x×]\s*6/i.test(part.section_designation || ""));
          assert.ok(channel>=0);
          await separate.getByLabel("Cost item",{exact:true}).selectOption(String(channel));
          await expect(separate).toContainText("stock length");
          await page.getByLabel("Quote setup step",{exact:true}).selectOption("scope");
          if (job.source_callouts?.some(row => row.status === "recovered" && row.part_id))
            await expect(shop.getByRole("button", {name:"Our shop supplies it"})).toBeVisible();
          await sections.getByRole("tab", {name:"Check the drawing"}).click();
          const checkPanel = page.getByRole("tabpanel", {name:"Check the drawing"});
          await expect(checkPanel.getByRole("heading",{name:"Check a reading"})).toBeVisible();
          const sources = checkPanel.getByLabel("Type of drawing check",{exact:true});
          if (await sources.locator("option[value=sources]").count()) {
            await sources.selectOption("sources");
            const item = checkPanel.locator('[id^="source-part-"]');
            await expect(item.getByText("AI entered",{exact:true}).first()).toBeVisible();
            await expect(item.locator(".bp-reading-source").first()).toBeVisible();
          }
          await expect(checkPanel.getByRole("button",{name:"Our shop supplies it"})).toHaveCount(0);
          await sections.getByRole("tab", {name:"Quote setup"}).click();
          await page.getByLabel("Quote setup step",{exact:true}).selectOption("specs");
          await expect(page.getByRole("heading",{name:"Fill only what you know"})).toBeVisible();
          await sections.getByRole("tab", {name:"What the AI found"}).click();
          await expect(inventory.getByRole("heading", {name: "What the AI found"})).toBeVisible();
          const search = inventory.getByRole("searchbox", { name: "Find a part" });
          await search.fill("C3");
          await expect(inventory.getByText(/C3\s*[x×]\s*6/i).first()).toBeVisible();
          await search.clear();
          await inventory.getByRole("button", {name:"Enter order quantity",exact:true}).first().click();
          await expect(page.getByRole("tab", {name:"Quote setup"})).toHaveAttribute("aria-selected", "true");
          await expect(page.locator("[id^=drawing-part-]").first().getByLabel("Quantity", {exact:true}).first()).toBeVisible();
        }
        await expect(page.getByRole("img", {name: "Drawing preview, page 1"}).first()).toBeVisible();
        if (job.ast?.source_release_hold) {
          await expect(page.getByText(/Source note.*not for construction/i)).toBeVisible();
          await expect(page.getByRole("button", { name: "Open quote draft" })).toBeEnabled();
        }
      }
      assert.ok(reads.some(s => s === 200), "Browser never loaded a job payload");
      await page.setViewportSize({ width: 390, height: 844 });
      if (!spec.sketch && job.state === "review_required") {
        const preview = page.getByRole("img",{name:"Drawing preview, page 1"}).first();
        await expect(preview).toBeHidden();
        await page.getByRole("button",{name:"Show preview"}).click();
        await expect(preview).toBeVisible();
        await page.getByRole("button",{name:"Hide preview"}).click();
        await expect(preview).toBeHidden();
      }
      const dimensions = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
      assert.ok(dimensions[0] <= dimensions[1] + 2, "Review overflows the mobile viewport " + dimensions);
      assert.deepEqual(errors, []);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.screenshot({ path: path.join(output, "review-" + index + ".png") });
      if (spec.control && !priorRun) {
        const width = job.reading.parts[0].annotations.findIndex(a => a.kind === "width");
        assert.ok(width >= 0, "The benchmark width was not read");
        const preview = async (reading) => {
          const r = await page.request.post(api + "/proof", { data: { version: job.version, reading, verified: [] } });
          assert.ok(r.ok());
          return await r.json();
        };
        const original = await preview(job.reading);
        assert.equal(original.geometry[0].bounds[2], 120);
        const amended = structuredClone(job.reading);
        Object.assign(amended.parts[0].annotations[width], {
          value: "125 mm", evidence: "QA control revision requests 125 mm width", confidence: 1,
        });
        const after = await preview(amended);
        assert.equal(after.geometry[0].bounds[2], 125);
        assert.notEqual(after.dxfs[0].sha256, original.dxfs[0].sha256);
        const submit = async (version, reading) => {
          const response = await page.request.post(api + "/review", { data: {
            version, reading, verified: [], confirmed: true,
            review_note: "Control fixture comparison against the original written dimension.",
          }});
          assert.ok(response.ok(), await response.text());
          await expect.poll(async () => {
            const saved = await (await fetch(api)).json();
            return saved.version > version && ["needs_review","released"].includes(saved.state);
          }, {timeout: 150_000}).toBe(true);
          return (await (await fetch(api)).json());
        };
        const held = await submit(job.version, amended);
        assert.equal(held.state, "needs_review");
        assert.equal(held.solution.source_check.status, "checked");
        assert.ok(held.solution.pins.some(pin => pin.code === "source_comparison"));
        assert.equal(held.files.length, 0);
        const released = await submit(held.version, job.reading);
        assert.equal(released.state, "released");
        await page.reload();
        await expect(page.getByRole("link", { name: /Full-size DXF/ }).first()).toBeVisible();
        await page.getByRole("button", { name: "Create or open quote" }).click();
        await page.waitForURL(/\/quotes\/[a-f0-9-]+$/);
        const draft = await (await page.request.get(desk + "/api/quotes/" + page.url().split("/").at(-1))).json();
        assert.equal(draft.items[0].quantity, 3);
      }
      await save(index, { id, endpoint, terminal: job.state, states: Array.from(states), ui: true });
      const checkScope = !spec.sketch && process.env.LMM_REAL_SOURCE_SCOPE_AUDIT === "1";
      if (!spec.control && (process.env.LMM_REAL_ASSISTANT_AUDIT === "1" || checkScope)) {
        await exerciseOriginal(page, index, spec, job);
      }
    } catch (error) {
      await save(index, { id, endpoint, states: Array.from(states), error: error.message });
    }
  }));
  const estimate = await browser.newPage();
  await estimate.goto(desk + "/quotes/demo-mounting-plate/workspace");
  await expect(estimate.locator(".rw-selling")).toHaveText("$266.67");
  await estimate.getByLabel("Fabrication labor (hours) amount", { exact: true }).fill("2");
  await expect(estimate.locator(".rw-selling")).toHaveText("$306.67");
  await writeFile(path.join(output, "quote-ui.json"), JSON.stringify({ hours: [1.5, 2], price: ["266.67", "306.67"] }));
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
}
