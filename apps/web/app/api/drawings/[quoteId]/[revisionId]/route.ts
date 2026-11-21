import { DrawingError, getDrawingPage, getDrawingRevision, getDrawingThumbnail } from "@/lib/drawings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ quoteId: string; revisionId: string }> }) {
  try {
    const { quoteId, revisionId } = await params;
    const url = new URL(request.url);
    const requestedPage = url.searchParams.get("page");
    if (requestedPage !== null) {
      if (!/^[1-9]\d*$/.test(requestedPage)) throw new DrawingError("Enter a positive page number.");
      const result = await getDrawingPage(quoteId, revisionId, Number(requestedPage));
      return new Response(new Uint8Array(result.bytes), { headers: {
        "Content-Type": result.mime,
        "X-Total-Pages": String(result.count),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400, immutable",
      } });
    }
    if (url.searchParams.has("thumbnail")) {
      const thumbnail = await getDrawingThumbnail(quoteId, revisionId);
      if (!thumbnail) throw new DrawingError("Preview not found.", 404);
      return new Response(new Uint8Array(thumbnail), { headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
    }
    const file = getDrawingRevision(quoteId, revisionId);
    if (!file) throw new DrawingError("Revision not found on this quote.", 404);
    const disposition = url.searchParams.has("download") ? "attachment" : "inline";
    const safeName = encodeURIComponent(file.fileName).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16));
    return new Response(new Uint8Array(file.bytes), { headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.size),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${safeName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "Content-Security-Policy": "frame-ancestors 'self'",
    } });
  } catch (error) {
    return Response.json({ error: error instanceof DrawingError ? error.message : "Unable to open this file." },
      { status: error instanceof DrawingError ? error.status : 500 });
  }
}
