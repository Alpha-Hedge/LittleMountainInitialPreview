import { createCanvas, loadImage } from "@napi-rs/canvas";
import convertHeic from "heic-convert";
import sharp from "sharp";
import { maxDrawingBytes } from "../drawing-types";
import { QuoteError } from "../quotes";
import type { SketchPhotoMime } from "./types";

export async function prepareSketchPhoto(file: File) {
  if (!file.size || file.size > maxDrawingBytes) {
    throw new QuoteError("Choose a photo up to 20 MB.", 413);
  }
  const fileName = file.name.split(/[\\/]/).at(-1)?.trim();
  if (
    !fileName ||
    fileName.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(fileName)
  ) {
    throw new QuoteError("Choose a photo with a valid file name.");
  }
  const original = Buffer.from(await file.arrayBuffer());
  const mimeType = photoType(original);
  try {
    if (mimeType === "image/png") {
      // PNG metadata can contain SVG text that canvas mistakes for the image.
      const preview = await sharp(original)
        .autoOrient()
        .resize(2400, 2400, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 93 })
        .toBuffer();
      return { fileName, mimeType, original, preview };
    }
    const image = await loadImage(
      mimeType === "image/heic"
        ? Buffer.from(
            await convertHeic({
              buffer: original,
              format: "JPEG",
              quality: 0.94,
            }),
          )
        : original,
    );
    if (!image.width || !image.height) throw new Error("Empty image");
    const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return {
      fileName,
      mimeType,
      original,
      preview: canvas.toBuffer("image/jpeg", 93),
    };
  } catch {
    throw new QuoteError(
      "Could not read this photo. Save a fresh copy or choose another photo.",
      422,
    );
  }
}

function photoType(bytes: Buffer): SketchPhotoMime {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    const brands = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/;
    for (
      let offset = 8;
      offset + 4 <= Math.min(bytes.readUInt32BE(0), bytes.length, 256);
      offset += 4
    ) {
      if (
        offset !== 12 &&
        brands.test(bytes.toString("ascii", offset, offset + 4))
      ) {
        return "image/heic";
      }
    }
  }
  throw new QuoteError("Choose a JPG, PNG, WebP, or HEIC photo.", 415);
}
