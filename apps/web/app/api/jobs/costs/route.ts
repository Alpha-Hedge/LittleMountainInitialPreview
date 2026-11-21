import { actualCosts } from "@/lib/actual-costs";
import { quoteResponse, readJson } from "@/app/api/quotes/_http";

export const runtime = "nodejs";
export function POST(request: Request) {
  return quoteResponse(async () => actualCosts(await readJson(request)));
}
