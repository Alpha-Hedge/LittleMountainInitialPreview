import PDFDocument from "pdfkit";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { workspaceRoot } from "./workspace-root";
import {
  frozenInternalCostSheet,
  renderInternalCostSheet,
} from "./internal-cost-sheet";
import { reviewOperations } from "./engineering-ledger";
import { getQuoteReview } from "./workflow";
import { getDb } from "./db";
import type { QuoteReviewView } from "./workflow-types";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
async function traveler(view: QuoteReviewView) {
  const { quote: q, drawing, details } = view.snapshot,
    stamp = new Date(view.approvedAt || q.updatedAt);
  const doc = new PDFDocument({
    size: "LETTER",
    autoFirstPage: false,
    margins: { left: 46, right: 46, top: 86, bottom: 46 },
    info: {
      Title: q.number + " · Internal shop traveler",
      Author: "Little Mountain Metalworks",
      CreationDate: stamp,
      ModDate: stamp,
    },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (b) => chunks.push(b));
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    doc.once("error", reject);
  });
  const fonts = path.join(
    workspaceRoot(),
    "node_modules",
    "pdfjs-dist",
    "standard_fonts",
  );
  doc
    .registerFont("Body", path.join(fonts, "LiberationSans-Regular.ttf"))
    .registerFont("Bold", path.join(fonts, "LiberationSans-Bold.ttf"));
  let page = 0;
  doc.on("pageAdded", () => {
    page++;
    doc.save().rect(0, 0, 612, 62).fill("#193c31").restore();
    doc
      .fillColor("#ffffff")
      .font("Bold")
      .fontSize(17)
      .text("Little Mountain Metalworks", 46, 17, { lineBreak: false });
    doc.font("Body").fontSize(9).text("INTERNAL SHOP TRAVELER", 370, 17, {
      width: 196,
      align: "right",
      lineBreak: false,
    });
    doc.text(q.number + "   /   Rev " + q.version + "   /   " + page, 365, 33, {
      width: 201,
      align: "right",
      lineBreak: false,
    });
    doc.font("Body").fillColor("#213630").fontSize(10);
    doc.x = 46;
    doc.y = 84;
  });
  doc.addPage();
  function write(value: string, size = 10, bold = false) {
    doc
      .font(bold ? "Bold" : "Body")
      .fontSize(size)
      .fillColor("#213630")
      .text(value, 46, doc.y, { width: 520, lineGap: 2 });
    doc.moveDown(0.35);
  }
  function space(height: number) {
    if (doc.y + height > 742) doc.addPage();
  }
  write(q.jobName, 23, true);
  write(
    q.customer +
      "   /   " +
      (view.approvedAt
        ? "Approved " + view.approvedAt.slice(0, 10)
        : "Working draft") +
      "   /   Revision " +
      q.version,
  );
  const sections = [
    ["Scope", details.scope],
    ["Lead time", details.leadTime],
    ["Drawing", drawing && drawing.fileName + " · " + drawing.label],
    ["Assumptions", details.assumptions],
    ["Request notes", q.notes],
  ];
  for (const [label, value] of sections)
    if (value) {
      space(48);
      write(label!, 11, true);
      write(value);
    }
  const ops = reviewOperations(q);
  q.items.forEach((item, i) => {
    space(75);
    doc.moveDown(0.5);
    write(item.description + "   /   Qty " + item.quantity, 15, true);
    for (const row of item.costRows) {
      const op = ops.find((v) => v.itemId === item.id && v.rowId === row.id)!;
      space(52);
      write(row.label + "   ·   " + usd(op.nickCost), 11, true);
      write(
        (op.nickHours != null
          ? Number(op.nickHours.toFixed(4)) + " batch hours   /   "
          : "") +
          row.amount +
          " " +
          (row.estimate?.unit ||
            (op.hourly ? "hours" : row.amount === 1 ? "unit" : "units")) +
          " × " +
          usd(row.rate) +
          "   /   " +
          (row.basis === "batch" ? "once per batch" : "per piece") +
          (row.review?.unitCost != null
            ? "   /   Entered cost " + usd(row.review.unitCost)
            : ""),
      );
      if (op.reason)
        write(
          "Override · " +
            op.reason +
            (op.disposition === "one_time" ? " (this job only)" : ""),
        );
    }
    if (q.totals.items[i].scrapCost)
      write(
        "Extra material allowance (" +
          q.scrapBufferPct +
          "%)   " +
          usd(q.totals.items[i].scrapCost!),
      );
    if (q.totals.items[i].contingencyCost)
      write("Budget contingency   "+usd(q.totals.items[i].contingencyCost!));
    write("Line cost   " + usd(q.totals.items[i].cost), 11, true);
  });
  space(92);
  doc.moveDown(0.5);
  write("Pricing summary", 15, true);
  write(
    "Estimated cost   " +
      usd(q.totals.estimatedCost) +
      "     /     Target gross margin   " +
      q.marginPercent +
      "%",
  );
  write(
    "Selling price before tax   " + usd(view.customer.sellingPrice),
    13,
    true,
  );
  doc.end();
  return done;
}
export async function internalBundle(id: string, version: number) {
  const view = getQuoteReview(id, version),
    q = view.snapshot.quote;
  const base = q.number + "-v" + q.version,
    db = getDb();
  db.exec(
    "CREATE TABLE IF NOT EXISTS shop_traveler_packages (quote_id TEXT NOT NULL,version INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(quote_id,version))",
  );
  const read = () =>
    db
      .prepare(
        "SELECT bytes FROM shop_traveler_packages WHERE quote_id=? AND version=?",
      )
      .get(id, version)?.bytes as Uint8Array | undefined;
  let bytes = view.approvedAt ? read() : undefined;
  if (!bytes) {
    const sheet =
      frozenInternalCostSheet(id, version)?.csv ||
      renderInternalCostSheet(q, view.customer);
    bytes = zipSync(
      {
        [base + "-shop-traveler.pdf"]: await traveler(view),
        [base + "-internal-costs.csv"]: strToU8(sheet),
      },
      { mtime: new Date(2000, 0, 1), level: 6 },
    );
    if (view.approvedAt) {
      db.prepare(
        "INSERT OR IGNORE INTO shop_traveler_packages VALUES(?,?,?)",
      ).run(id, version, bytes);
      bytes = read()!;
    }
  }
  return { bytes, filename: base + "-internal.zip" };
}
