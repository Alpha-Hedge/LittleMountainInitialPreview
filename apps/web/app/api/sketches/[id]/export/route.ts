import { QuoteError } from "@/lib/quotes";
import { confirmedFiles, getConfirmedSketch } from "@/lib/sketch/store";
import { fileResponse, sketchResponse, sketchVersion } from "../../_http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return sketchResponse(async () => {
    const query = new URL(request.url).searchParams;
    const version = sketchVersion(Number(query.get("version")));
    const { id } = await params;
    const draft = getConfirmedSketch(id, version);
    const stem =
      draft.title
        .replace(/[^a-z\d]+/gi, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 72) || "shop-drawing";
    const fileName = stem + "-v" + version;
    switch (query.get("format")) {
      case "pdf":
        return fileResponse(
          Buffer.from((await confirmedFiles(id, version)).pdf, "base64"),
          "application/pdf",
          fileName + ".pdf",
        );
      case "csv":
        return fileResponse(
          Buffer.from((await confirmedFiles(id, version)).csv, "base64"),
          "text/csv; charset=utf-8",
          fileName + "-cut-list.csv",
        );
      case "dxf": {
        const selected = query.get("part");
        const part = selected === null ? -1 : Number(selected);
        if (!Number.isInteger(part) || part < 0 || part >= draft.parts.length) {
          throw new QuoteError("Choose the part to export.");
        }
        return fileResponse(
          Buffer.from((await confirmedFiles(id, version)).dxfs[part], "base64"),
          "application/dxf",
          fileName + "-part-" + (part + 1) + ".dxf",
        );
      }
      default:
        throw new QuoteError("Choose a shop PDF, DXF, or cut list.");
    }
  });
}
