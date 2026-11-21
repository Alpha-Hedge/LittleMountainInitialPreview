import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { DrawingError, uploadDrawing } from "@/lib/drawings";
import { readDrawingUpload } from "@/lib/drawing-upload";
import {
  drawingDraftCustomer,
  drawingDraftPart,
  drawingDraftPartId,
} from "@/lib/quote-start";
import { createQuote, QuoteError } from "@/lib/quotes";
import { newQuoteDraft } from "@/lib/types";
import { getEstimatingSettings } from "@/lib/estimating";
import { quoteResponse } from "../_http";

export const runtime = "nodejs";

export function POST(request: Request) {
  return quoteResponse(async () => {
    try {
      const form = await readDrawingUpload(request);
      const file = form.get("file");
      const notes = form.get("notes") ?? "";
      const token = form.get("token") ?? randomUUID();
      if (!(file instanceof File))
        throw new DrawingError("Choose a drawing or photo.");
      if (typeof notes !== "string" || notes.length > 50_000) {
        throw new QuoteError(
          "Use 50,000 characters or less for customer notes.",
        );
      }
      if (typeof token !== "string" || !/^[a-f0-9-]{36}$/i.test(token)) {
        throw new QuoteError("Start the upload again.");
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      const jobName =
        file.name
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.[^.]+$/, "")
          .trim() || "Untitled job";
      const db = getDb();
      const receiptName = "drawing_start:" + token;
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db
          .prepare("SELECT value FROM app_meta WHERE name = ?")
          .get(receiptName);
        if (previous) {
          db.exec("COMMIT");
          return JSON.parse(String(previous.value));
        }
        const quote = createQuote({
          ...newQuoteDraft(getEstimatingSettings().defaultMargin),
          customer: drawingDraftCustomer,
          jobName: jobName.slice(0, 240),
          notes,
          items: [
            {
              id: drawingDraftPartId,
              description: drawingDraftPart,
              quantity: 1,
              costRows: [],
            },
          ],
        });
        const saved = uploadDrawing(
          quote.id,
          { bytes, fileName: file.name },
          "",
          "",
        );
        const result = {
          quoteId: quote.id,
          revisionId: saved.selectedRevisionId,
        };
        db.prepare("INSERT INTO app_meta VALUES (?, ?)").run(
          receiptName,
          JSON.stringify(result),
        );
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      if (error instanceof DrawingError)
        throw new QuoteError(error.message, error.status);
      throw error;
    }
  }, 201);
}
