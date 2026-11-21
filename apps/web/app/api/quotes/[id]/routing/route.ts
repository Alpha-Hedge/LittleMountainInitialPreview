import { calculateRouting, savedRouting } from "@/lib/work-center-routing";
import { QuoteError } from "@/lib/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const item = new URL(request.url).searchParams.get("itemId") ?? "";
  return Response.json({ saved: savedRouting((await params).id, item) });
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(await calculateRouting((await params).id, await request.json()));
  } catch (error) {
    return Response.json({ error: error instanceof QuoteError ? error.message : "Could not calculate this routing. Check the engineering service." },
      { status: error instanceof QuoteError ? error.status : 503 });
  }
}
