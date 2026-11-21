import "./test-typescript.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const { drawingIssues, partBounds, partContours, polylinePath } = await import(
  "../apps/web/lib/sketch/geometry.ts"
);
const { compileShopFiles } = await import(
  "../apps/web/lib/sketch/exports.ts"
);

const draft = {
  title: "Mounting plates",
  units: "in",
  parts: [
    {
      name: "Mounting plate",
      material: "A36 steel",
      thickness: 0.25,
      quantity: 4,
      notes: 'Deburr all edges, mark "A"',
      outline: {
        kind: "rectangle",
        width: 6,
        height: 4,
        cornerRadius: 0.25,
        vertices: [],
      },
      holes: [
        {
          shape: "round",
          centerX: 1,
          centerY: 1,
          diameter: 0.5,
          width: null,
          length: null,
          angle: null,
        },
        {
          shape: "slot",
          centerX: 4,
          centerY: 2.5,
          diameter: null,
          width: 0.5,
          length: 1.75,
          angle: 30,
        },
      ],
    },
  ],
};
assert.deepEqual(drawingIssues(draft), []);
const [outline, circle, slot] = partContours(draft.parts[0]);
assert.deepEqual(partBounds(draft.parts[0]), {
  minX: 0,
  minY: 0,
  maxX: 6,
  maxY: 4,
  width: 6,
  height: 4,
});
assert.deepEqual(circle, {
  kind: "circle",
  center: { x: 1, y: 1 },
  radius: 0.25,
});
assert.equal(outline.vertices.length, 8);
assert.equal(outline.vertices.filter((vertex) => vertex.bulge > 0).length, 4);
assert.equal(slot.vertices.filter((vertex) => vertex.bulge === 1).length, 2);
assert.match(polylinePath(outline.vertices), /^M .* A .* Z$/);
assert.match(polylinePath(slot.vertices), /^M .* A .* Z$/);

const release = await compileShopFiles(draft, 1);
const dxf = Buffer.from(release.dxfs[0], "base64").toString("utf8");
const metric = structuredClone(draft);
metric.units = "mm";
const metricFile = Buffer.from((await compileShopFiles(metric, 1)).dxfs[0], "base64");
function checkEntities(data, expectedUnit) {
  const fields = data.replaceAll("\r", "").split("\n").map(v => v.trim());
  const units = fields.indexOf("$INSUNITS");
  assert.ok(units >= 0);
  assert.equal(fields[units + 2], String(expectedUnit));
  const start = fields.indexOf("ENTITIES");
  assert.ok(start >= 0);
  const entities = fields.slice(start, fields.indexOf("ENDSEC", start));
  assert.equal(entities.filter(v => v === "LWPOLYLINE").length, 3);
  assert.equal(entities.filter(v => v === "1_CUT_INNER").length, 2);
  assert.equal(entities.filter(v => v === "0_CUT_OUTER").length, 1);
  assert.ok(!entities.some(v => ["CIRCLE", "TEXT", "DIMENSION", "MTEXT", "INSERT"].includes(v)));
}
checkEntities(dxf, 1);
checkEntities(metricFile.toString("utf8"), 4);
const cutList = Buffer.from(release.csv, "base64").toString("utf8");
assert.ok(cutList.includes('Deburr all edges, mark ""A""'));
assert.ok(cutList.includes("Pierces per piece"));
const formulas = structuredClone(draft);
formulas.parts[0].notes = '=WEBSERVICE("example")';
const escaped = Buffer.from((await compileShopFiles(formulas, 1)).csv, "base64").toString();
assert.match(escaped, /"'=WEBSERVICE/);

const missing = structuredClone(draft);
missing.units = null;
missing.parts[0].quantity = null;
missing.parts[0].holes[0].centerY = null;
assert.equal(drawingIssues(missing).length, 3);
await assert.rejects(() => compileShopFiles(missing, 1), /Choose inches or millimeters/);
const badCorner = structuredClone(draft);
badCorner.parts[0].holes[0].centerX = 0.25;
assert.match(drawingIssues(badCorner).join("\n"), /fully inside/);
const roundedAllTheWay = structuredClone(draft);
roundedAllTheWay.parts[0].outline.cornerRadius = 2;
assert.deepEqual(drawingIssues(roundedAllTheWay), []);
assert.equal(partContours(roundedAllTheWay.parts[0])[0].vertices.length, 6);
const overlap = structuredClone(draft);
overlap.parts[0].holes.push({
  ...overlap.parts[0].holes[0],
  centerX: 4,
  centerY: 2.5,
});
assert.match(drawingIssues(overlap).join("\n"), /touch or overlap/);

const polygon = structuredClone(draft);
const [part] = polygon.parts;
part.outline = {
  kind: "polygon",
  width: null,
  height: null,
  cornerRadius: null,
  vertices: [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 4 },
    { x: 5, y: 4 },
    { x: 5, y: 2 },
    { x: 3, y: 2 },
    { x: 3, y: 4 },
    { x: 0, y: 4 },
  ],
};
part.holes = [
  {
    shape: "slot",
    centerX: 4,
    centerY: 3,
    width: 0.5,
    length: 6,
    angle: 0,
    diameter: null,
  },
];
assert.match(drawingIssues(polygon).join("\n"), /fully inside/);
part.holes = [];
assert.deepEqual(drawingIssues(polygon), []);
assert.equal(partBounds(part).width, 8);
part.outline.vertices = [
  { x: 0, y: 0 },
  { x: 6, y: 4 },
  { x: 6, y: 0 },
  { x: 0, y: 4 },
];
assert.match(drawingIssues(polygon).join("\n"), /cross or touch/);

const pdf = Buffer.from(release.pdf, "base64");
assert.match(pdf.subarray(0, 8).toString("ascii"), /^%PDF-/);
const multipage = structuredClone(draft);
multipage.parts[0].notes = Array.from(
  { length: 35 },
  (_, i) => "Shop instruction " + (i + 1),
).join("\n");
multipage.parts.push({ ...draft.parts[0], name: "Second plate" });
const multiple = await compileShopFiles(multipage, 2);
const longPdf = Buffer.from(multiple.pdf, "base64");
assert.equal(multiple.partPages[0], 1);
assert.ok(multiple.partPages[1] > multiple.partPages[0]);
const output = process.argv[2];
if (output) {
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(path.join(output, "test-inch.dxf"), dxf),
    writeFile(path.join(output, "test-metric.dxf"), metricFile),
    writeFile(path.join(output, "test-shop-drawing.pdf"), pdf),
    writeFile(path.join(output, "test-multiple-shop-sheets.pdf"), longPdf),
    writeFile(path.join(output, "test-cut-list.csv"), cutList),
  ]);
}
console.log(
  "Sketch geometry, cut contours, DXF units, PDF export, and CSV validation passed.",
);
