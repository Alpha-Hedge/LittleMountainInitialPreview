import { internalBundle } from "@/lib/shop-traveler";
import { QuoteError } from "@/lib/quotes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const version = Number(new URL(request.url).searchParams.get("version"));
    if (!Number.isSafeInteger(version) || version < 1)
      throw new QuoteError("Choose a saved quote version.");
    const bundle = await internalBundle((await params).id, version);
    return new Response(Uint8Array.from(bundle.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="' + bundle.filename + '"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof QuoteError)
      return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
