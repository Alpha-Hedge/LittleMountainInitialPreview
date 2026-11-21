import { calculateQuote } from "../../../../lib/quotes";
import { quoteResponse, readJson } from "../_http";

export const runtime = "nodejs";

export function POST(request: Request) {
  return quoteResponse(async () => calculateQuote(await readJson(request)));
}
