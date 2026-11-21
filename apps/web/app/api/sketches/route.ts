import { randomUUID } from "node:crypto";
import { DrawingError } from "@/lib/drawings";
import { readDrawingUpload } from "@/lib/drawing-upload";
import { QuoteError } from "@/lib/quotes";
import { addSketch, listSketches } from "@/lib/sketch/store";
import { sketchResponse } from "./_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return sketchResponse(listSketches);
}

export function POST(request: Request) {
  return sketchResponse(async () => {
    try {
      const form = await readDrawingUpload(request);
      const file = form.get("file");
      const token = form.get("token") ?? randomUUID();
      if (!(file instanceof File))
        throw new QuoteError("Choose a photo of your sketch.");
      if (
        typeof token !== "string" ||
        !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(token)
      ) {
        throw new QuoteError("Start the photo upload again.");
      }
      return addSketch(file, token);
    } catch (error) {
      if (error instanceof DrawingError)
        throw new QuoteError(error.message, error.status);
      throw error;
    }
  }, 201);
}
