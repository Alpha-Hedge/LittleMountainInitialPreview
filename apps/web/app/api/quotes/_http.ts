import { QuoteError } from "../../../lib/quotes";

export async function quoteResponse(action: () => unknown | Promise<unknown>, status = 200) {
  try {
    return Response.json(await action(), { status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof QuoteError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Quote operation failed", error);
    return Response.json({ error: "The quote could not be processed." }, { status: 500 });
  }
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new QuoteError("Send a valid JSON quote.");
  }
}
