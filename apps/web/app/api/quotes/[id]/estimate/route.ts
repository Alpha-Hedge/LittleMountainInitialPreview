import { applyOperations } from "@/lib/estimating";
import { previewEstimate } from "@/lib/history";
import { QuoteError } from "@/lib/quotes";
import { quoteResponse, readJson } from "../../_http";

export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return quoteResponse(async () => {
    const { id } = await context.params;
    const body = await readJson(request);
    if (!body || typeof body !== "object" || !("action" in body)) throw new QuoteError("Choose an estimate action.");
    if (body.action === "apply") return applyOperations(id, body);
    if (body.action === "suggest" && "itemId" in body && typeof body.itemId === "string" &&
        "templateId" in body && typeof body.templateId === "string") return previewEstimate(id, body.itemId, body.templateId);
    throw new QuoteError("Choose a quote line and template.");
  });
}
