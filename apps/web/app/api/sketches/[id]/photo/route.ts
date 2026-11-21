import { getSketchPhoto } from "@/lib/sketch/store";
import { fileResponse, sketchResponse } from "../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return sketchResponse(async () => {
    const original = new URL(request.url).searchParams.get("original") === "1";
    const file = getSketchPhoto((await params).id, original);
    return fileResponse(
      file.bytes,
      file.mimeType,
      original ? file.fileName : undefined,
    );
  });
}
