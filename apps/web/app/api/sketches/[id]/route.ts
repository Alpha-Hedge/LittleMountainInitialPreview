import { QuoteError } from "@/lib/quotes";
import {
  extractSketch,
  getSketch,
  linkSketchQuote,
  saveSketch,
} from "@/lib/sketch/store";
import { sketchResponse, sketchVersion } from "../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export function GET(_request: Request, { params }: Context) {
  return sketchResponse(async () => getSketch((await params).id));
}

export function PATCH(request: Request, { params }: Context) {
  return sketchResponse(async () => {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object")
      throw new QuoteError("Choose what to do with this sketch.");
    const version = sketchVersion(body.version);
    switch (body.action) {
      case "read":
        return extractSketch(id, version);
      case "save":
        return saveSketch(id, version, body.draft);
      case "confirm":
        if (body.acknowledged !== true) {
          throw new QuoteError(
            "Check the drawing dimensions against the photo before confirming.",
          );
        }
        return saveSketch(id, version, body.draft, true);
      case "quote":
        return linkSketchQuote(id, version);
      default:
        throw new QuoteError("Choose what to do with this sketch.");
    }
  });
}
