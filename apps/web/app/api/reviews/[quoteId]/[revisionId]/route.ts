import { quoteResponse, readJson } from "@/app/api/quotes/_http";
import { DrawingError } from "@/lib/drawings";
import { QuoteError } from "@/lib/quotes";
import { editReview, extractReview, listReviews } from "@/lib/reviews";
import { runVision } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

type Context = { params: Promise<{ quoteId: string; revisionId: string }> };

function reviewResponse(context: Context, action: (quoteId: string, revisionId: string) => unknown, status = 200) {
  return quoteResponse(async () => {
    const { quoteId, revisionId } = await context.params;
    try {
      return await action(quoteId, revisionId);
    } catch (error) {
      if (error instanceof DrawingError) throw new QuoteError(error.message, error.status);
      throw error;
    }
  }, status);
}

export function GET(_request: Request, context: Context) {
  return reviewResponse(context, listReviews);
}

export function POST(request: Request, context: Context) {
  return reviewResponse(context, async (quoteId, revisionId) => {
    const body = await readJson(request);
    if (!body || typeof body !== "object" || !("action" in body) || body.action !== "extract" || !("version" in body)) {
      throw new QuoteError("Request a drawing extraction for the saved quote version.");
    }
    return extractReview(quoteId, revisionId, body.version, runVision);
  }, 201);
}

export function PATCH(request: Request, context: Context) {
  return reviewResponse(context, async (quoteId, revisionId) => editReview(quoteId, revisionId, await readJson(request)));
}
