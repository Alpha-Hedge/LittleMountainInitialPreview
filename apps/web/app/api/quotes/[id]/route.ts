import { getQuote, QuoteError, updateQuote } from "../../../../lib/quotes";
import { quoteResponse, readJson } from "../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export function GET(_request: Request, context: Context) {
  return quoteResponse(async () => {
    const { id } = await context.params;
    const quote = getQuote(id);
    if (!quote) throw new QuoteError("Quote not found.", 404);
    return quote;
  });
}

export function PUT(request: Request, context: Context) {
  return quoteResponse(async () => updateQuote((await context.params).id, await readJson(request)));
}
