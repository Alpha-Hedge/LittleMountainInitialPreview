import { createQuote, listQuotes } from "../../../lib/quotes";
import { quoteResponse, readJson } from "./_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return quoteResponse(listQuotes);
}

export function POST(request: Request) {
  return quoteResponse(async () => createQuote(await readJson(request)), 201);
}
