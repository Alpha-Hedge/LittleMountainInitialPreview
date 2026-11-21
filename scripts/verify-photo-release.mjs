// Exercises the normal staff flow against the isolated engineering stack and a new local quote database.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { chromium, expect } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cfg = parseEnv(await readFile(path.join(root, ".env.nfip-test"), "utf8"));
assert.equal(cfg.NFIP_API_URL, "http://127.0.0.1:8141");
const folder = path.join(root, ".test-results");
await mkdir(folder, { recursive: true });
const out = await mkdtemp(path.join(folder, "photo-release-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = "http://127.0.0.1:" + port;
const api = cfg.NFIP_API_URL + "/drawings/from-sketch";
const headers = { authorization: "Bearer " + cfg.NFIP_API_TOKEN };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const apiCall = (tail, opts = {}) =>
  fetch(api + tail, { ...opts, headers: { ...headers, ...opts.headers } });
let server, browser;
async function start() {
  server = spawn(
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
        LMM_DATA_DIR: out,
        LMM_SUPABASE_DATA_DIR: path.join(out, "unconnected"),
        NFIP_ARCHIVE_DATA_DIR: out,
        NFIP_ARCHIVE_ENV: ".env.nfip-test",
        NFIP_API_URL: cfg.NFIP_API_URL,
        NFIP_API_TOKEN: cfg.NFIP_API_TOKEN,
      },
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/api/sketch-conversions")).ok) return;
    } catch {}
    await delay(350);
  }
  throw Error("Test desk did not start");
}
async function stop() {
  if (server && server.exitCode === null) {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
}
try {
  await start();
  assert.equal((await fetch(api)).status, 401);
  const fixture = path.join(root, "fixtures/sketches");
  const raw = await readFile(path.join(fixture, "slotted-mounting-plate.png"));
  const key = randomUUID();
  const multipart = new FormData();
  multipart.set(
    "file",
    new Blob([raw], { type: "image/png" }),
    "slotted-mounting-plate.png",
  );
  const upload = await apiCall("", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: multipart,
  });
  assert.equal(upload.status, 200);
  const ready = await upload.json();
  assert.equal(ready.state, "released", JSON.stringify(ready.solution?.pins));
  assert.deepEqual(
    ready.files.map((f) => f.name),
    ["part-001.dxf", "shop-drawing.pdf", "bom.csv"],
  );
  const prefix = "/" + ready.drawing_id;
  const orig = Buffer.from(
    await (
      await fetch(cfg.NFIP_API_URL + ready.source_url, { headers })
    ).arrayBuffer(),
  );
  assert.deepEqual(orig, raw);
  for (const f of ready.files) {
    const response = await fetch(cfg.NFIP_API_URL + f.href, { headers });
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(body), f.sha256);
    await writeFile(path.join(out, f.name), body);
  }
  const replay = await apiCall(
    "?filename=slotted-mounting-plate.png&wait_seconds=0",
    {
      method: "POST",
      headers: { "content-type": "image/png", "Idempotency-Key": key },
      body: raw,
    },
  );
  assert.equal((await replay.json()).drawing_id, ready.drawing_id);
  assert.equal(
    (
      await apiCall("?filename=other.png", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: raw,
      })
    ).status,
    409,
  );
  assert.equal(
    (await apiCall("", { method: "POST", body: "broken image" })).status,
    415,
  );

  const changed = structuredClone(ready.reading);
  const width = changed.parts[0].annotations.find((a) => a.kind === "width");
  assert.ok(width);
  changed.parts[0].annotations.push({
    ...width,
    value: "127",
    evidence: "Test conflicting width 127",
  });
  const review = {
    version: 1,
    reading: changed,
    review_note: "Regression fixture with conflicting dimensions.",
    confirmed: true,
    verified: [],
  };
  const post = (body) =>
    apiCall(prefix + "/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const reviewed = await (await post(review)).json();
  assert.equal(reviewed.state, "needs_review");
  assert.ok(
    reviewed.solution.pins.some(
      (p) => p.code === "conflict" && p.annotation !== null,
    ),
  );
  assert.deepEqual(reviewed.files, []);
  assert.equal((await apiCall(prefix + "/files/2/part-001.dxf")).status, 409);
  assert.equal((await (await post(review)).json()).version, 2);
  assert.equal(
    (await post({ ...review, review_note: "Stale, changed request." })).status,
    409,
  );
  assert.deepEqual(
    (await (await apiCall(prefix + "?version=1")).json()).files,
    ready.files,
  );

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
    viewport: { width: 1370, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/sketches");
  await page
    .getByLabel("Choose photo or PDF", { exact: true })
    .setInputFiles(path.join(fixture, "bench-plate-missing.jpg"));
  await page.getByRole("button", { name: "Upload & read sketch" }).click();
  await page.waitForURL(/\/sketches\/photo\/[a-f0-9-]+$/);
  const url = page.url();
  const id = url.split("/").at(-1);
  await page.getByRole("button", { name: "Review measurements", exact: true }).click({timeout:300000});
  await expect(
    page.getByRole("heading", { name: /Details to check \(\d+\)/ }),
  ).toBeVisible({ timeout: 300000 });
  await expect(page.getByRole("link", { name: /Full-size DXF/ })).toHaveCount(
    0,
  );
  await page.getByLabel("Show detected features").check();
  await page.getByRole("button", { name: "Show check markers on photo" }).click();
  await page
    .getByRole("button", { name: "Go to check 1", exact: true })
    .click({ force: true });
  let saved = await (await apiCall("/" + id)).json();
  assert.equal(saved.evidence.provider.toLowerCase(), "openai");
  const supplied = {
    height: "4",
    width: "6",
    material: "A36 steel",
    radius: "square",
    quantity: "4",
    thickness: "1/4",
    diameter: "1/2",
  };
  function answer(p) {
    if (p.field === "x") return p.target === "H1" ? "1" : "5";
    return p.field === "y" ? "1" : supplied[p.field];
  }
  const first = saved.solution.pins.findIndex(p=>p.field);
  assert.ok(first >= 0, "The fixture needs an unanswered measurement.");
  const firstPin = saved.solution.pins[first];
  await page.getByLabel("Jump to a check").selectOption(String(first));
  await page.locator("#pin-"+first).getByRole("textbox").fill(answer(firstPin));
  await page.getByRole("button",{name:"Save this review"}).click();
  await expect(page.getByRole("status").filter({hasText:"Revision 2 saved."}).first()).toBeVisible({timeout:45000});
  await expect(page.getByRole("button",{name:"Review measurements",exact:true})).toHaveAttribute("aria-pressed","true");
  saved = await (await apiCall("/"+id)).json();
  assert.equal(saved.version,2);
  assert.equal(saved.state,"needs_review");
  assert.ok(saved.reading.parts.some(part => part.annotations.some(a => a.evidence === "Staff confirmed "+answer(firstPin))));
  await page.locator("#sketch-signoff").getByRole("button",{name:"Save and check",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"Revision 3 saved."}).first()).toBeVisible({timeout:45000});
  saved = await (await apiCall("/"+id)).json();
  assert.equal(saved.version,3);
  assert.equal(saved.state,"needs_review");
  for (const [i, p] of saved.solution.pins.entries()) {
    await page.getByLabel("Jump to a check").selectOption(String(i));
    const row = page.locator("#pin-" + i);
    if (p.field) {
      const value = answer(p);
      assert.ok(value, "Unexpected missing measurement " + p.field);
      await row.locator("input:not([type=checkbox])").fill(value);
    } else if (p.code === "clarify" || p.review_key)
      await row.getByRole("checkbox").check();
    else assert.fail(p.message);
  }
  await page
    .getByLabel("Review note")
    .fill(
      "Fixture clarification: plate height 4 in; centers 1 and 5 in across, both 1 in up.",
    );
  await page.getByRole("button", { name: "Confirm and make files" }).click();
  await expect(
    page.getByRole("heading", { name: "Drawing files ready" }),
  ).toBeVisible({ timeout: 45000 });
  assert.match(page.url(), /version=4/);
  const pdf = page.getByRole("link", { name: "Annotated shop PDF" });
  assert.equal(
    (
      await page.request.get(
        await pdf.getAttribute("href").then((h) => base + h),
      )
    ).status(),
    200,
  );
  await page.getByRole("button", { name: "Create or open quote" }).click();
  await page.waitForURL(/\/quotes\/[a-f0-9-]+$/);
  const quoteURL = page.url();
  const q = await (
    await fetch(base + "/api/quotes/" + quoteURL.split("/").at(-1))
  ).json();
  assert.equal(q.items[0].quantity, 4);
  await page.getByRole("link", { name: "Open source sketch" }).click();
  await page.waitForURL(url + "?version=4");
  await page.getByLabel("Saved revisions").selectOption("1");
  await page.getByRole("button", { name: "Review measurements", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Details to check \(\d+\)/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and make files" }),
  ).toHaveCount(0);
  await page.getByLabel("Saved revisions").selectOption("4");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: "Annotated shop PDF" }),
  ).toBeVisible();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 2,
    ),
  );
  await stop();
  await start();
  await page.goto(url + "?version=4");
  await page.getByRole("button", { name: "Create or open quote" }).click();
  await page.waitForURL(quoteURL);
  assert.deepEqual(errors, []);
  console.log(
    "Verified one-call multipart release, checksums, upload retry, version history, stale edit, blocked release, live browser photo upload and corrections, mobile layout, linked quote and restart.",
  );
  console.log(
    "Live provider/model:",
    saved.evidence.provider,
    saved.evidence.model,
  );
  console.log("Release", ready.drawing_id, "reviewed", id, "files", out);
} finally {
  await browser?.close();
  await stop();
}
