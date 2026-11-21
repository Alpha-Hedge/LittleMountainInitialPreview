import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";

const live = process.argv.includes("--live");
const base = "http://127.0.0.1:3192";
const output = path.resolve(".test-results");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(path.join(output, "sketch-flow-"));
const fixture = (kind) =>
  path.resolve("fixtures", "sketches", "bench-plate-" + kind + ".jpg");
const next = fileURLToPath(new URL("./web.mjs", import.meta.url));
const expected = (missing) => ({
  draft: {
    title: "Bench Mounting Plate",
    units: "in",
    parts: [
      {
        name: "Bench Mounting Plate",
        material: "A36 steel",
        thickness: 0.25,
        quantity: 4,
        notes: "Both holes through.",
        bendLines: [],
        outline: {
          kind: "rectangle",
          width: 6,
          height: missing ? null : 4,
          cornerRadius: 0,
          vertices: [],
        },
        holes: [1, 5].map((x) => ({
          shape: "round",
          centerX: missing ? null : x,
          centerY: missing ? null : 1,
          diameter: 0.5,
          width: null,
          length: null,
          angle: null,
        })),
      },
    ],
  },
  findings: [{ label: "Width", value: "6 in", evidence: "6.00" }],
  questions: missing
    ? ["What is the plate height?", "Where are the two hole centers?"]
    : [],
});

let reads = 0;
const mock = live
  ? null
  : createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const image = body.messages?.[1]?.content?.[0]?.image_url?.url;
      assert.ok(image?.startsWith("data:image/jpeg;base64,"));
      assert.equal(body.response_format.json_schema.strict, true);
      const content = JSON.stringify(expected(++reads === 1));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
        }),
      );
    });
if (mock) {
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
}

const env = {
  ...process.env,
  LMM_DATA_DIR: folder,
  LMM_SUPABASE_DATA_DIR: path.join(folder, "disabled"),
  LMM_SUPABASE_READ_URL: "",
  LMM_SUPABASE_WRITE_URL: "",
  VISION_PROVIDER: live ? "openai" : "llama.cpp",
  VISION_MODEL: live ? "gpt-6.1-terra" : "sketch-test",
  ...(mock
    ? { VISION_BASE_URL: "http://127.0.0.1:" + mock.address().port + "/v1" }
    : {}),
};

let browser, server;
async function start() {
  server = spawn(
    process.execPath,
    [next, "start", "--hostname", "127.0.0.1", "--port", "3192"],
    {
      env,
      windowsHide: true,
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(base + "/api/sketches")).ok) return;
    } catch {}
    await delay(250);
  }
  throw Error("The isolated sketch app did not start.");
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = once(server, "exit");
  server.kill();
  await stopped;
}

async function request(route, status = 200, options) {
  const response = await fetch(base + route, options);
  assert.equal(response.status, status, await response.clone().text());
  return response;
}

const change = (route, data, status = 200) =>
  request(route, status, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

async function upload(kind, token = crypto.randomUUID(), status = 201) {
  const form = new FormData();
  form.set(
    "file",
    new Blob([await readFile(fixture(kind))], { type: "image/jpeg" }),
    path.basename(fixture(kind)),
  );
  form.set("token", token);
  return (
    await request("/api/sketches", status, { method: "POST", body: form })
  ).json();
}

try {
  await start();
  const pngName = "slotted-mounting-plate.png";
  const pngBytes = await readFile(path.join("fixtures", "sketches", pngName));
  const pngForm = new FormData();
  pngForm.set("file", new Blob([pngBytes], { type: "image/png" }), pngName);
  const pngJob = await (
    await request("/api/sketches", 201, { method: "POST", body: pngForm })
  ).json();
  assert.equal(pngJob.mimeType, "image/png");
  const pngRoute = "/api/sketches/" + pngJob.id + "/photo";
  const pngOriginal = await request(pngRoute + "?original=1");
  assert.equal(pngOriginal.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await pngOriginal.arrayBuffer()), pngBytes);
  const pngPreview = await request(pngRoute);
  assert.equal(pngPreview.headers.get("content-type"), "image/jpeg");
  assert.equal(Buffer.from(await pngPreview.arrayBuffer()).readUInt16BE(0), 0xffd8);

  const incomplete = await upload("missing");
  const incompleteRoute = "/api/sketches/" + incomplete.id;
  const needsInfo = await (
    await change(incompleteRoute, {
      action: "read",
      version: incomplete.version,
    })
  ).json();
  assert.equal(needsInfo.draft.parts[0].outline.height, null);
  assert.equal(needsInfo.draft.parts[0].holes[0].centerX, null);
  assert.ok(needsInfo.questions.length);
  await change(
    incompleteRoute,
    {
      action: "confirm",
      version: needsInfo.version,
      draft: needsInfo.draft,
      acknowledged: true,
    },
    422,
  );
  await request(
    incompleteRoute + "/export?format=dxf&part=0&version=" + needsInfo.version,
    409,
  );

  const token = crypto.randomUUID();
  const [first, second] = await Promise.all([
    upload("complete", token),
    upload("complete", token),
  ]);
  assert.equal(
    first.id,
    second.id,
    "Upload retry should return the same sketch",
  );
  const route = "/api/sketches/" + first.id;
  const original = await request(route + "/photo?original=1");
  assert.deepEqual(
    Buffer.from(await original.arrayBuffer()),
    await readFile(fixture("complete")),
  );

  const executablePath = [
    process.env.CHROME_PATH,
    path.join(
      process.env.PROGRAMFILES || "",
      "Google/Chrome/Application/chrome.exe",
    ),
    path.join(
      process.env["PROGRAMFILES(X86)"] || "",
      "Microsoft/Edge/Application/msedge.exe",
    ),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((name) => name && existsSync(name));
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
  await page.goto(base);
  await page.getByText("Menu", { exact: true }).click();
  await page
    .getByRole("link", { name: "Sketch to drawing", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sketch to drawing", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Choose photo", { exact: true })
    .setInputFiles(fixture("complete"));
  await page.screenshot({ path: path.join(folder, "upload-phone.png") });
  const reading = page.waitForResponse(
    (response) => response.request().method() === "PATCH",
    { timeout: 100_000 },
  );
  await page.getByRole("button", { name: "Upload & read sketch" }).click();
  const result = await reading;
  assert.equal(result.status(), 200, await result.text());
  const recognized = await result.json();
  const sketch = "/api/sketches/" + recognized.id;
  const part = recognized.draft.parts[0];
  assert.equal(recognized.draft.units, "in");
  assert.deepEqual(
    [part.outline.width, part.outline.height, part.quantity, part.thickness],
    [6, 4, 4, 0.25],
  );
  assert.deepEqual(
    part.holes
      .map((hole) => [hole.centerX, hole.centerY, hole.diameter])
      .sort(),
    [
      [1, 1, 0.5],
      [5, 1, 0.5],
    ],
  );
  await expect(
    page.getByRole("button", { name: "Confirm shop drawing" }),
  ).toBeDisabled();
  const viewport = page.getByRole("img", { name: /plan view/ });
  await expect(viewport).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(page.getByLabel("View zoom")).toHaveText("200%");
  await page.getByRole("button", { name: "Fit part" }).click();
  await expect(page.getByLabel("View zoom")).toHaveText("100%");
  assert.ok(await viewport.locator("canvas").evaluate(canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return pixels.some((alpha, i) => i % 4 === 3 && alpha > 0);
  }), "CAD viewport painted geometry");
  await page.getByRole("button", { name: "Add bend mark" }).click();
  for (const [label,value] of [["Start X","0"],["Start Y","2"],["End X","6"],["End Y","2"]]) {
    await page.getByLabel(label, { exact:true }).fill(value);
  }
  await page.getByLabel("Bend note (optional)").fill("UP 90°");
  await expect(page.locator(".sk-cad-legend").getByText("Bend mark")).toBeVisible({ timeout:30000 });
  await page
    .getByRole("checkbox", { name: /I checked the dimensions/ })
    .check();
  await page.getByRole("button", { name: "Confirm shop drawing" }).click();
  const download = page.getByRole("link", {
    name: "Download shop PDF",
    exact: true,
  });
  await expect(download).toBeVisible();
  await expect(page.getByRole("region", { name: "Ready for the shop" })).toBeFocused();
  const version = (await (await request(sketch)).json()).version;
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.screenshot({ path: path.join(folder, "confirmed-desktop.png") });
  const files = [
    ["pdf", "shop.pdf", "application/pdf", "%PDF"],
    ["dxf&part=0", "part.dxf", "application/dxf", "LWPOLYLINE"],
    ["csv", "cut-list.csv", "text/csv", "0.25"],
  ];
  for (const [format, name, type, marker] of files) {
    const response = await request(
      sketch + "/export?format=" + format + "&version=" + version,
    );
    assert.match(response.headers.get("content-type"), new RegExp(type));
    const data = Buffer.from(await response.arrayBuffer());
    assert.ok(data.includes(marker));
    await writeFile(path.join(folder, name), data);
  }

  await page.getByRole("button", { name: "Start quote from cut list" }).click();
  await expect(
    page.getByRole("link", { name: "Open linked quote" }),
  ).toBeVisible();
  const linked = (await (await request(sketch)).json()).linkedQuoteId;
  assert.equal(
    (await (await change(sketch, { action: "quote", version })).json())
      .linkedQuoteId,
    linked,
  );
  const quoteRoute = "/api/quotes/" + linked;
  const quote = await (await request(quoteRoute)).json();
  assert.equal(quote.items.length, 1);
  assert.equal(quote.items[0].quantity, 4);
  assert.match(quote.items[0].description, /A36/i);
  const drawings = await (await request("/api/drawings/" + linked)).json();
  assert.equal(drawings.attachments.length, 2);
  const preview = await request(quoteRoute + "/estimate", 200, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "suggest",
      itemId: quote.items[0].id,
      templateId: "drilled-plate",
    }),
  });
  const estimate = await preview.json();
  assert.equal(estimate.fields.dimensions, "6 x 4");
  assert.equal(
    estimate.rows.find((row) => row.estimate.operationId === "drilling").amount,
    0.1,
  );
  await page.getByRole("link", { name: "Open linked quote" }).click();
  await expect(page.getByRole("link", { name: "Open source sketch" }))
    .toHaveAttribute("href", "/sketches/" + recognized.id);

  await change(
    sketch,
    { action: "save", version: version - 1, draft: recognized.draft },
    409,
  );
  await stop();
  await start();
  assert.equal((await (await request(sketch)).json()).linkedQuoteId, linked);
  await request(sketch + "/export?format=dxf&part=0&version=" + version);
  const reopenedPhoto = await request(sketch + "/photo?original=1");
  assert.deepEqual(
    Buffer.from(await reopenedPhoto.arrayBuffer()),
    await readFile(fixture("complete")),
  );
  const edited = structuredClone(recognized.draft);
  edited.parts[0].quantity = 5;
  const newer = await (
    await change(sketch, { action: "save", version, draft: edited })
  ).json();
  assert.equal(newer.confirmed, false);
  await request(sketch + "/export?format=dxf&part=0&version=" + newer.version, 409);
  const pinned = await request(sketch + "/export?format=csv&version=" + version);
  assert.equal(await pinned.text(), await readFile(path.join(folder, "cut-list.csv"), "utf8"));
  assert.equal((await (await request(quoteRoute)).json()).items[0].quantity, 4);
  if (!live) assert.equal(reads, 2, "Expected one read per sketch");
  console.log(
    "Verified",
    live ? "live Terra" : "fixture reader",
    "phone-width upload, blank missing measurements, confirmation, all three exports, applied quote specs and drilling amount, retries and restart.",
  );
  console.log(folder);
} finally {
  await browser?.close();
  await stop();
  if (mock) mock.close();
}
