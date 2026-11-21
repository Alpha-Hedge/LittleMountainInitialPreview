import { sketchResponse } from "../../_http";
import { previewSketch } from "@/lib/sketch/exports";
import { parseSketchDraft } from "@/lib/sketch/parse";
import { getSketch } from "@/lib/sketch/store";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return sketchResponse(async () => {
    getSketch((await params).id);
    const { draft } = await request.json();
    return previewSketch(parseSketchDraft(draft));
  });
}
