// Run with the production web build and the isolated Compose stack populated by the Phase 2/3 acceptance runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url)),
  cfg = parseEnv(await readFile(path.join(root, ".env.nfip-test"), "utf8"));
assert.equal(cfg.NFIP_API_URL, "http://127.0.0.1:8141");
const results = path.join(root, ".test-results");
await mkdir(results, { recursive: true });
const dir = await mkdtemp(path.join(results, "phase4-")),
  probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const base = "http://127.0.0.1:" + port,
  auth = { Authorization: "Bearer " + cfg.NFIP_API_TOKEN };
const launch = () =>
  spawn(
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
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        LMM_DATA_DIR: dir,
        NFIP_ARCHIVE_DATA_DIR: dir,
        NFIP_ARCHIVE_ENV: ".env.nfip-test",
        LMM_SUPABASE_DATA_DIR: path.join(dir, "unconnected"),
        NFIP_API_URL: cfg.NFIP_API_URL,
        NFIP_API_TOKEN: cfg.NFIP_API_TOKEN,
      },
    },
  );
let server = launch(),
  browser;
const ready = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + "/api/quotes")).ok) return;
    } catch {}
    await sleep(250);
  }
  throw Error("Test desk startup");
};
const stop = async () => {
  if (server && server.exitCode === null) {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
};
async function call(url, data, method = "POST") {
  const r = await fetch(url, {
    method: data ? method : "GET",
    headers: {
      ...(url.startsWith(cfg.NFIP_API_URL) ? auth : {}),
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await r.json();
  assert.ok(r.ok, JSON.stringify(body).slice(0, 800));
  return body;
}
const { unzipSync } = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
)("fflate");
try {
  await ready();
  const db = new DatabaseSync(path.join(dir, "quotes.sqlite"));
  // Give this isolated desk independent quote numbers when it syncs with the reusable test archive.
  db.prepare("UPDATE quotes SET sequence=? WHERE id='demo-mounting-plate'").run(
    Date.now(),
  );
  db.close();
  const exe =
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
  browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  const qbase = base + "/api/quotes/demo-mounting-plate",
    workspace = base + "/quotes/demo-mounting-plate/workspace";
  await page.goto(workspace);
  await expect(page.locator(".rw-selling")).toHaveText("$266.67");
  await page.getByLabel("Add material scrap buffer").check();
  await expect(page.locator(".rw-selling")).toHaveText("$277.33");
  await page.getByRole("slider").fill("20");
  await expect(page.locator(".rw-selling")).toHaveText("$260.00");
  await page
    .getByLabel("Fabrication labor (hours) amount", { exact: true })
    .fill("2");
  await page
    .getByLabel("Fabrication labor (hours) reason", { exact: true })
    .fill("Extra fixture alignment");
  await page.locator(".rw-part").filter({has:page.getByLabel("Local delivery cost override",{exact:true})}).locator(":scope > summary").click();
  await page
    .getByLabel("Local delivery cost override", { exact: true })
    .fill("35");
  await page
    .getByLabel("Local delivery reason", { exact: true })
    .fill("One-time loading charge");
  await page
    .locator(".rw-operation")
    .filter({ has: page.getByLabel("Local delivery amount", { exact: true }) })
    .getByText("One-time exception for this job")
    .check();
  await expect(page.locator(".rw-selling")).toHaveText("$303.75");
  await page.getByRole("button", { name: "Save pricing revision" }).click();
  await page.waitForURL(/version=2/);
  await page.waitForLoadState("networkidle");
  const v2 = await call(qbase);
  assert.equal(v2.totals.estimatedCost, 243);
  assert.equal(v2.items[1].costRows[0].review.disposition, "one_time");
  const before = await call(qbase + "/approval");
  const d = {
    ...before.snapshot.details,
    scope: "Supply ten finished mounting plates and deliver once.",
    leadTime: "Two weeks from order",
    scopeConfirmed: true,
    leadTimeConfirmed: true,
    terms: "Net 30",
    expiresOn: "2099-12-31",
    pricingDecision: {
      kind: "standard",
      reason: "Fixture and local delivery reviewed",
    },
    resolutions: Object.fromEntries(
      before.snapshot.questions.map((q) => [
        q.id,
        "Checked with the fixture customer",
      ]),
    ),
  };
  const submitted = await call(qbase + "/approval", {
    version: v2.version,
    action: "submit",
    drawingId: before.snapshot.drawing?.id || null,
    details: d,
  });
  const approved = await call(qbase + "/approval", {
    version: submitted.snapshot.quote.version,
    action: "approve",
    drawingId: before.snapshot.drawing?.id || null,
  });
  const av = approved.snapshot.quote.version;
  await page.goto(workspace + "?version=" + av);
  const publicLink = page.getByRole("link", {
      name: "Download Customer Proposal PDF",
    }),
    internalLink = page.getByRole("link", {
      name: "Download Internal Shop Traveler & CSV",
    });
  const bytes = async (link) => {
    const r = await fetch(new URL(await link.getAttribute("href"), base));
    assert.equal(r.status, 200);
    return Buffer.from(await r.arrayBuffer());
  };
  const publicPdf = await bytes(publicLink),
    pack = await bytes(internalLink),
    files = unzipSync(pack);
  assert.equal(Object.keys(files).length, 2);
  const privatePdf = files[Object.keys(files).find((n) => n.endsWith(".pdf"))],
    csv = Buffer.from(
      files[Object.keys(files).find((n) => n.endsWith(".csv"))],
    ).toString();
  await writeFile(path.join(dir, "customer.pdf"), publicPdf);
  await writeFile(path.join(dir, "traveler.pdf"), privatePdf);
  const readPDF = async (name) => {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await getDocument({
      data: Uint8Array.from(await readFile(path.join(dir, name))),
      useSystemFonts: true,
    }).promise;
    try {
      const pages = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        pages.push(
          (await page.getTextContent()).items.map((i) => i.str).join(" "),
        );
      }
      return pages.join("\n");
    } finally {
      await doc.destroy();
    }
  };
  const pub = await readPDF("customer.pdf"),
    staff = await readPDF("traveler.pdf");
  assert.match(pub, /\$303\.75/);
  assert.doesNotMatch(
    pub,
    /Extra fixture alignment|gross margin|estimated cost|\$243\.00/i,
  );
  for (const re of [
    /INTERNAL SHOP TRAVELER/,
    /Extra fixture alignment/,
    /20%/,
    /\$243\.00/,
    /\$303\.75/,
  ])
    assert.match(staff, re);
  assert.match(csv, /Material scrap buffer/);
  assert.match(csv, /one_time/);
  await page.getByRole("button", { name: "Revise pricing" }).click();
  await page.getByRole("slider").fill("25");
  await expect(page.locator(".rw-selling")).toHaveText("$324.00");
  await page.getByRole("button", { name: "Save pricing revision" }).click();
  await page.waitForURL(new RegExp("version=" + (av + 1)));
  await stop();
  server = launch();
  await ready();
  await page.goto(workspace + "?version=" + av);
  assert.deepEqual(await bytes(publicLink), publicPdf);
  assert.deepEqual(await bytes(internalLink), pack);
  console.log(
    "Manual prices, overrides, margin, material buffer, two exports, restart and frozen revision passed.",
  );
  const jobs = await call(base + "/api/blueprints/jobs"),
    bp = jobs.find(
      (j) =>
        j.state === "ready" &&
        j.drawing.type === "CUSTOMER_PDF" &&
        j.customer_name === "Blueprint acceptance fixture",
    );
  assert.ok(bp, "Seed the test stack with tests.blueprint_flow");
  const shopFile =
    base + "/api/blueprints/jobs/" + bp.id + "/shop-files/" + bp.version + "/1";
  const [firstDXF, secondDXF] = await Promise.all([
    fetch(shopFile),
    fetch(shopFile),
  ]);
  assert.equal(firstDXF.status, 200);
  assert.equal(secondDXF.status, 200);
  const dxf = Buffer.from(await firstDXF.arrayBuffer());
  assert.deepEqual(dxf, Buffer.from(await secondDXF.arrayBuffer()));
  assert.match(dxf.toString("latin1"), /0_CUT_OUTER/);
  await writeFile(path.join(dir, "reviewed-part.dxf"), dxf);
  const mapped = await call(base + "/api/blueprints/jobs/" + bp.id + "/draft", {
    version: bp.version,
  });
  await page.goto(base + "/quotes/" + mapped.id + "/workspace");
  await expect(page.locator(".bw-outline").first()).toBeVisible();
  await expect(page.getByText(/Original proposal/).first()).toBeVisible();
  await page
    .locator(".rw-operation")
    .first()
    .getByText(/Estimate basis and sources/)
    .click();
  await expect(
    page
      .locator(".rw-operation")
      .first()
      .getByText("Past job", { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit drawing measurements" }).click();
  const canvas = page.getByRole("region", {
    name: "Interactive drawing review",
  });
  await canvas
    .getByRole("button", { name: /Outline width/ })
    .first()
    .click();
  const width = Number(await canvas.getByLabel("Drawing value").inputValue());
  const after = page.waitForResponse(
    (r) =>
      r.url().endsWith("/proof") &&
      r.request().postDataJSON()?.ast?.parts[0].outline.width_in === width + 1,
  );
  await canvas.getByLabel("Drawing value").fill(String(width + 1));
  const proof = await (await after).json();
  assert.equal(
    proof.geometry[0].bounds[2] - proof.geometry[0].bounds[0],
    width + 1,
  );
  assert.ok(proof.pdf && proof.dxfs.length);
  await page.screenshot({
    path: path.join(dir, "drawing-workspace.png"),
    fullPage: false,
  });
  await page.getByRole("button", { name: "Cancel drawing changes" }).click();
  const blueprintQuote = await call(base + "/api/quotes/" + mapped.id);
  const setupRow = blueprintQuote.items[0].costRows.find(
    (r) => r.estimate?.category === "setup",
  );
  assert.ok(setupRow);
  const setup = page
    .locator(".rw-line")
    .first()
    .locator(".rw-operation")
    .filter({
      has: page.getByLabel(setupRow.label + " amount", { exact: true }),
    })
    .first();
  await setup
    .getByLabel(setupRow.label + " amount", { exact: true })
    .fill("1.5");
  await setup
    .getByLabel(setupRow.label + " reason", { exact: true })
    .fill("Square the fixture before clamping");
  await page.getByRole("button", { name: "Save pricing revision" }).click();
  await page.waitForURL(new RegExp("version=" + (blueprintQuote.version + 1)));
  const approvalURL = base + "/api/quotes/" + mapped.id + "/approval",
    bpReview = await call(approvalURL);
  const reviewDetails = {
    ...d,
    lineDescriptions: bpReview.snapshot.details.lineDescriptions,
    resolutions: Object.fromEntries(
      bpReview.snapshot.questions.map((q) => [
        q.id,
        "Confirmed from the two-page fixture drawing",
      ]),
    ),
  };
  const readyReview = await call(approvalURL, {
    action: "submit",
    version: bpReview.snapshot.quote.version,
    drawingId: bpReview.snapshot.drawing.id,
    details: reviewDetails,
  });
  const finalized = await call(approvalURL, {
    action: "approve",
    version: readyReview.snapshot.quote.version,
    drawingId: bpReview.snapshot.drawing.id,
  });
  const approvedQuote = finalized.snapshot.quote;
  const archiveURL =
    cfg.NFIP_API_URL +
    "/v1/quotes/" +
    approvedQuote.number +
    "/versions/" +
    approvedQuote.version;
  await expect
    .poll(async () => (await fetch(archiveURL, { headers: auth })).status, {
      timeout: 45000,
    })
    .toBe(200);
  const published = await call(archiveURL);
  const saved = published.lines[0].entered.review_operations.find(
    (r) => r.rowId === setupRow.id,
  );
  assert.equal(saved.aiHours, 0.25);
  assert.equal(saved.nickHours, 1.5);
  assert.equal(saved.aiCost, 21.25);
  assert.equal(saved.nickCost, 127.5);
  assert.ok(
    saved.citations.length && saved.reason.includes("Square the fixture"),
  );
  console.log(
    "Reviewed blueprint estimate retained proposed and approved hours, costs, reason and citations in PostgreSQL.",
  );
  const photos = await call(base + "/api/sketch-conversions"),
    sk = photos.find(
      (s) => s.state === "released" && s.filename === "roller-guard-camera.jpg",
    );
  assert.ok(sk, "Seed the isolated Phase 3 roller-guard example.");
  const surl = base + "/api/sketch-conversions/" + sk.drawing_id,
    prior = await call(surl + "?version=" + sk.version);
  await page.goto(
    base + "/sketches/photo/" + sk.drawing_id + "?version=" + sk.version,
  );
  await page.getByRole("button", { name: "Revise drawing" }).click();
  await page.getByText("Inspect AI readings and drawing preview", { exact: true }).click();
  const photoCanvas = page.getByRole("region", {
    name: "Interactive drawing review",
  });
  await photoCanvas
    .getByRole("button", { name: /weld /i })
    .last()
    .click({ force: true });
  const weldOption = await photoCanvas
    .getByLabel("Measurement or weld callout")
    .locator("option")
    .evaluateAll(
      (options) => options.find((o) => /\bweld\b/i.test(o.textContent)).value,
    );
  await photoCanvas
    .getByLabel("Measurement or weld callout")
    .selectOption(weldOption);
  const changed = page.waitForResponse(
    (r) =>
      r.url().endsWith("/proof") &&
      r.request().postData()?.includes("3/16 fillet weld, arrow side"),
  );
  await photoCanvas
    .getByLabel("Drawing value")
    .fill("3/16 fillet weld, arrow side");
  const welded = await (await changed).json();
  assert.ok(welded.pdf && welded.dxfs.length);
  await writeFile(
    path.join(dir, "weld-proof.pdf"),
    Buffer.from(welded.pdf, "base64"),
  );
  assert.match(await readPDF("weld-proof.pdf"), /3\/16 fillet weld/);
  const uncertain = structuredClone(prior.reading);
  uncertain.parts[0].annotations[0].confidence = 0.84;
  const flagged = await call(surl + "/proof", {
    version: prior.version,
    reading: uncertain,
    verified: prior.verified,
  });
  assert.ok(flagged.issues.length);
  const archived = await call(surl + "?version=" + sk.version);
  assert.deepEqual(archived.files, prior.files);
  // Replay an uncertain provider reading through the normal UI, keeping the stored source immutable.
  await page.route(
    "**/api/sketch-conversions/" + sk.drawing_id + "?version=" + sk.version,
    (route) => route.fulfill({ json: { ...prior, reading: uncertain } }),
  );
  await page.reload();
  await page.getByRole("button", {name:"Review measurements", exact:true}).click();
  await page.getByText("Inspect AI readings and drawing preview", {exact:true}).click();
  await expect(page.locator(".bw-pin.low").first()).toBeVisible();
  await expect(page.locator(".bw-pin.high").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 845 });
  await page.goto(workspace + "?version=" + av);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  const batch = "P4-UI-" + randomUUID().slice(0, 8);
  for (let i = 1; i <= 3; i++) {
    const ops = ["setup", "run"].map((stage) => ({
      rowId: stage,
      center: batch,
      category: "cut",
      stage,
      aiHours: 1,
      nickHours: 1.25,
      aiCost: 60,
      nickCost: 75,
      reason: "Allow time for fixture alignment",
      disposition: "standard",
    }));
    await call(cfg.NFIP_API_URL + "/v1/quote-versions", {
      quote_number: batch + "-" + i,
      revision: 1,
      customer_name: batch,
      job_name: batch + " fixture " + i,
      status: "approved",
      gross_margin_pct: 25,
      pricing_inputs: {},
      lines: [
        {
          line_key: "fixture",
          description: "Plate",
          quantity: 1,
          entered: {
            retrieval: { material_family: "carbon steel" },
            review_operations: ops,
          },
          ai_proposed: { operations: ops },
          nick_approved: { operations: ops },
          confidence_score: 0.92,
          citations: [],
        },
      ],
    });
  }
  await expect
    .poll(
      async () =>
        (await call(base + "/api/settings/nick-rules?suggestions=1")).filter(
          (r) => r.adjustment.work_center === batch,
        ).length,
      { timeout: 30000 },
    )
    .toBe(2);
  await page.goto(base + "/settings");
  await page.getByRole("button", { name: "Estimating rules", exact: true }).click();
  await page.getByText("Nick’s Rules · Blueprint estimating rules").click();
  const pending = page
    .getByRole("region", { name: "Suggested rules" })
    .locator("article")
    .filter({ hasText: batch });
  await expect(pending).toHaveCount(2);
  await pending.first().getByText("Supporting jobs (3)").click();
  await expect(
    pending
      .first()
      .getByText(/Allow time for fixture alignment/)
      .first(),
  ).toBeVisible();
  await pending
    .first()
    .getByRole("button", { name: "Approve suggestion" })
    .click();
  await expect(pending).toHaveCount(1);
  await pending
    .first()
    .getByRole("button", { name: "Dismiss suggestion" })
    .click();
  await expect(pending).toHaveCount(0);
  const active = await call(base + "/api/settings/nick-rules");
  assert.equal(
    active.filter((r) => r.adjustment.work_center === batch).length,
    1,
  );
  console.log(
    "Nick approved and dismissed worker-generated suggestions through Shop settings.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "CAD overlay, source citations, dimension and weld recompiles, confidence colors and mobile layout passed. " +
      dir,
  );
} finally {
  await browser?.close();
  await stop();
}
