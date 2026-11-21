// A separate Node process keeps PDF.js workers and native canvas out of Next's bundle.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

const [input, mime, destination, mode, requestedPage] = process.argv.slice(2);
const bytes = await readFile(input);
const maxSide = 1500;
const pages = [];
if (mime === "application/pdf") {
  const loading = getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await loading.promise;
  try {
    const preview = mode === "preview";
    const first = preview ? Number(requestedPage) : 1;
    if (!Number.isSafeInteger(first) || first < 1)
      throw new Error("Invalid page number.");
    const last = preview ? Math.min(first, pdf.numPages) : pdf.numPages;
    if (preview)
      await writeFile(
        path.join(destination, "page-count"),
        String(pdf.numPages),
      );
    if (!preview && last > 12)
      throw new Error("Drawing review supports up to 12 pages per revision.");
    for (let number = first; number <= last; number++) {
      const page = await pdf.getPage(number);
      const box = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: maxSide / Math.max(box.width, box.height),
      });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport,
      }).promise;
      if (preview) {
        await writeFile(
          path.join(destination, "thumbnail.png"),
          canvas.toBuffer("image/png"),
        );
        page.cleanup();
        break;
      }
      await writeFile(
        path.join(destination, number + ".jpg"),
        canvas.toBuffer("image/jpeg", 90),
      );
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join(""),
      );
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
} else if (mime === "image/png") {
  await sharp(bytes)
    .autoOrient()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toFile(path.join(destination, "1.jpg"));
  pages.push("");
} else {
  const image = await loadImage(bytes);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  await writeFile(
    path.join(destination, "1.jpg"),
    canvas.toBuffer("image/jpeg", 90),
  );
  pages.push("");
}
await writeFile(
  path.join(destination, "pages.json"),
  JSON.stringify(pages),
  "utf8",
);
