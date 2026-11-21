import { DrawingError, getDrawingState, selectDrawingRevision, uploadDrawing } from "@/lib/drawings";
import { readDrawingUpload } from "@/lib/drawing-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ quoteId: string }> };

function failure(error: unknown) {
  if (error instanceof DrawingError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Drawing request failed", error instanceof Error ? error.name : "unknown");
  return Response.json({ error: "Unable to access drawing storage." }, { status: 500 });
}

export async function GET(_request: Request, { params }: Context) {
  try {
    return Response.json(getDrawingState((await params).quoteId));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const form = await readDrawingUpload(request);
    const file = form.get("file");
    if (!(file instanceof File)) throw new DrawingError("Choose a drawing file.");
    const label = form.get("label") ?? "";
    const group = form.get("attachmentId") ?? "";
    if (typeof label !== "string" || typeof group !== "string") throw new DrawingError("Invalid revision details.");
    const result = uploadDrawing((await params).quoteId, { bytes: Buffer.from(await file.arrayBuffer()), fileName: file.name }, group, label);
    return Response.json(result, { status: 201 });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const body = await request.json().catch(() => null);
    if (typeof body?.revisionId !== "string") throw new DrawingError("Choose a drawing revision.");
    return Response.json(selectDrawingRevision((await params).quoteId, body.revisionId));
  } catch (error) { return failure(error); }
}
