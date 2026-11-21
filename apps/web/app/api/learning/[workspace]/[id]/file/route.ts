import { readApprovedFile } from "@/lib/cloud-history";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspace: string; id: string }> },
) {
  const { workspace, id } = await params,
    query = new URL(request.url).searchParams;
  const asset = query.get("asset");
  if (asset !== "pdf" && asset !== "drawing") return new Response(null, { status: 400 });
  const result = await readApprovedFile(workspace, id, Number(query.get("version")), asset);
  if (!result) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(result.bytes), {
    headers: {
      "Content-Type": result.mime,
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(result.name),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
