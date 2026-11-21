import "./test-typescript.mjs";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";

const { runVision } = await import("../apps/web/lib/vision.ts");
const { fieldKeys } = await import("../apps/web/lib/review-types.ts");

const holes = "4X DIA 12 THRU";
const weld = "6 mm fillet weld both sides";
const conflictingWeld = "4 mm fillet weld both sides";
const drawing = new PDFDocument();
const chunks = [];
drawing.on("data", (chunk) => chunks.push(chunk));
const finished = new Promise((resolve, reject) => {
  drawing.once("end", resolve);
  drawing.once("error", reject);
});
drawing.text("Bench bracket").text(holes);
drawing.addPage().text(weld).text("Conflicting detail: " + conflictingWeld);
drawing.end();
await finished;
const revision = { fileName: "bracket.pdf", mimeType: "application/pdf", bytes: Buffer.concat(chunks) };
const combined = holes + ", " + weld;
const fields = Object.fromEntries(fieldKeys.map((key) => [key, []]));
fields.description = [{ value: "Bench bracket", page: 1, excerpt: "Bench bracket" }];
const cloudRequirement = {
  value: combined,
  page: 1,
  excerpt: holes,
  additionalExcerpts: [{ page: 2, excerpt: weld }],
};

process.env.OPENAI_API_KEY = "offline-fixture";
let expectedProvider;
let answer;
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  const part = body.response_format.json_schema.schema.properties.parts.items;
  const requirement = part.properties.requirements.items;
  if (expectedProvider === "openai") {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.ok(requirement.required.includes("additionalExcerpts"));
    const sources = requirement.properties.additionalExcerpts;
    assert.equal(sources.type, "array");
    assert.deepEqual(sources.items.required, ["page", "excerpt"]);
    assert.equal(sources.items.additionalProperties, false);
    assert.match(body.messages[0].content, /contiguous span/);
  } else {
    assert.equal(url, "http://127.0.0.1:8187/v1/chat/completions");
    assert.deepEqual(requirement.required, ["value", "page", "excerpt"]);
  }
  assert.equal(part.properties.quantity.items.properties.additionalExcerpts, undefined);
  assert.equal(body.messages[1].content.filter((entry) => entry.type === "image_url").length, 2);
  answer = JSON.stringify({ parts: [fields] });
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: answer } }] });
};

async function read(provider, requirements) {
  expectedProvider = process.env.VISION_PROVIDER = provider;
  fields.requirements = requirements;
  const { parts, raw } = await runVision(revision, "");
  assert.equal(JSON.parse(JSON.parse(raw).drawing).choices[0].message.content, answer);
  return parts[0].fields.requirements;
}

const found = await read("openai", [cloudRequirement]);
assert.deepEqual(found, {
  value: combined,
  status: "found",
  evidence: [
    { page: 1, excerpt: holes, verbatim: true },
    { page: 2, excerpt: weld, verbatim: true },
  ],
});
const conflict = await read("openai", [
  cloudRequirement,
  { value: conflictingWeld, page: 2, excerpt: conflictingWeld, additionalExcerpts: [] },
]);
assert.equal(conflict.status, "conflict");
assert.equal(conflict.value, combined + " | " + conflictingWeld);
assert.deepEqual(conflict.evidence, [...found.evidence, { page: 2, excerpt: conflictingWeld, verbatim: true }]);
const wrongPage = await read("openai", [{ ...cloudRequirement, additionalExcerpts: [{ page: 1, excerpt: weld }] }]);
assert.equal(wrongPage.evidence[1].verbatim, false);
await assert.rejects(read("openai", [{ ...cloudRequirement, additionalExcerpts: [{ page: 3, excerpt: weld }] }]), /invalid part or source/i);

process.env.VISION_BASE_URL = "http://127.0.0.1:8187/v1";
const local = await read("llama.cpp", [{ value: combined, page: 1, excerpt: holes }]);
assert.equal(local.value, combined);
assert.deepEqual(local.evidence, [found.evidence[0]]);
console.log("Passed separate cross-page hole and weld citations, contradictory welds, page validation, raw output, and the local drawing contract.");
