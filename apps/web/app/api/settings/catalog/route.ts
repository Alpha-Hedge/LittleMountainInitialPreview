import { quoteResponse } from "@/app/api/quotes/_http";
import { catalogRequest } from "@/lib/engineering-catalog";
import { QuoteError } from "@/lib/quotes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return quoteResponse(() => catalogRequest()); }
export function POST(request: Request) {
  return quoteResponse(async () => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && new URL(origin).host !== request.headers.get("host"))
      throw new QuoteError("Use the shop settings screen to save rates.",403);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new QuoteError("Send a JSON catalog entry.",415);
    const { kind, entry } = await request.json();
    if (kind !== "work-centers" && kind !== "materials") throw new QuoteError("Choose a catalog.");
    return catalogRequest(kind,entry);
  });
}
