import { NextRequest, NextResponse } from "next/server";
import { engineeringConnection } from "@/lib/engineering-connection";
import { quoteFromSketchRelease } from "@/lib/sketch/store";
import {
  toShopDraft,
  type SketchConversion,
} from "@/lib/sketch/conversion-types";
import { QuoteError } from "@/lib/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ path?: string[] }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const revision = /^[1-9]\d{0,8}$/;
const files = /^(part-\d{3}\.dxf|shop-drawing\.pdf|bom\.csv)$/;

function error(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function route(request: NextRequest, context: Context) {
  const parts = (await context.params).path || [];
  const [id, action, arg, file] = parts;
  const version = request.nextUrl.searchParams.get("version");
  if ((id && !uuid.test(id)) || (version !== null && !revision.test(version)))
    return error("Invalid drawing revision.", 400);
  const write = request.method === "POST";
  const origin = request.headers.get("origin");
  if (
    write &&
    origin &&
    origin !== request.nextUrl.origin &&
    new URL(origin).host !== request.headers.get("host")
  )
    return error("Open the sketch desk to save changes.", 403);
  const connection = engineeringConnection();
  if (!connection)
    return error("The engineering service is not connected to this desk.", 503);
  const headers = new Headers({ Authorization: "Bearer " + connection.token });
  const base = "/drawings/from-sketch" + (id ? "/" + id : "");
  const fetchFile = (path: string) =>
    fetch(connection.origin + path, { headers, cache: "no-store" });
  const query = new URLSearchParams();
  let target = base;
  let body: ReadableStream<Uint8Array> | null = null;
  if (!write) {
    if (parts.length <= 1) {
      if (id && version) query.set("version", version);
    } else if (parts.length === 2 && action === "source")
      target = "/v1/drawings/" + id + "/source";
    else if (id && version && action === "visual" && (
      parts.length === 2 || (parts.length === 3 && ["image", "pdf"].includes(arg))
    )) {
      target += parts.length === 2 ? "/visual" : "/visual/" + arg;
      query.set("version", version);
      if (request.nextUrl.searchParams.get("download") === "true")
        query.set("download", "true");
    }
    else if (
      parts.length === 3 &&
      action === "preview" &&
      ["page", "overlay"].includes(arg)
    )
      target += "/preview/" + arg;
    else if (
      parts.length === 4 &&
      action === "files" &&
      revision.test(arg) &&
      files.test(file)
    )
      target += "/files/" + arg + "/" + file;
    else return error("Drawing file unavailable.", 404);
  } else if (!id) {
    query.set("wait_seconds", "0");
    query.set("review_first", "true");
    const filename = request.nextUrl.searchParams.get("filename");
    if (filename) query.set("filename", filename);
    const key = request.headers.get("Idempotency-Key");
    if (key) headers.set("Idempotency-Key", key);
    headers.set(
      "content-type",
      request.headers.get("content-type") || "application/octet-stream",
    );
    body = request.body;
  } else if (parts.length === 2 && action === "visual" && version) {
    target += "/visual";
    query.set("version", version);
    if (request.nextUrl.searchParams.get("redo") === "true") query.set("redo", "true");
    if (request.nextUrl.searchParams.get("new_image") === "true") query.set("new_image", "true");
  } else if (parts.length === 2 && ["retry", "review", "proof", "draft"].includes(action)) {
    target += "/" + action;
    query.set("wait_seconds", "0");
    if (action === "retry" && version) query.set("version", version);
    if (action === "review" || action === "proof" || action === "draft") {
      headers.set("content-type", "application/json");
      body = request.body;
    }
  } else if (parts.length === 2 && action === "quote" && version) {
    const status = await fetchFile(base + "?version=" + version);
    if (!status.ok)
      return error("This sketch revision could not be opened.", status.status);
    const record: SketchConversion = await status.json();
    if (record.state !== "released" || !record.solution?.drawing)
      return error("Confirm the drawing and make its files first.", 409);
    const photoReady = ["image/jpeg", "image/png", "image/webp"].includes(
      record.mime,
    );
    const [photo, pdf] = await Promise.all([
      fetchFile(
        photoReady ? "/v1/drawings/" + id + "/source" : base + "/preview/page",
      ),
      fetchFile(base + "/files/" + version + "/shop-drawing.pdf"),
    ]);
    if (!photo.ok || !pdf.ok)
      return error("The saved drawing files could not be opened.", 503);
    const [photoBytes, pdfBytes] = await Promise.all([
      photo.arrayBuffer(),
      pdf.arrayBuffer(),
    ]);
    const quoteId = quoteFromSketchRelease(
      id,
      Number(version),
      toShopDraft(record.solution.drawing),
      {
        bytes: Buffer.from(photoBytes),
        fileName: photoReady ? record.filename : "Sketch-photo.jpg",
      },
      Buffer.from(pdfBytes),
      record.part_pages,
    );
    return NextResponse.json({ quoteId });
  } else return error("Drawing action unavailable.", 404);

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    cache: "no-store",
  };
  if (body) {
    init.body = body;
    init.duplex = "half";
  }
  const result = await fetch(
    connection.origin + target + (query.size ? "?" + query : ""),
    init,
  );
  if (!result.ok) {
    const details = await result.json().catch(() => ({}));
    const message =
      typeof details.detail === "string"
        ? details.detail
        : Array.isArray(details.detail)
          ? details.detail
              .slice(0, 3)
              .map((d: { loc?: string[]; msg?: string }) =>
                [d.loc?.slice(1).join("."), d.msg].filter(Boolean).join(" "),
              )
              .join(". ")
          : "";
    return error(
      message || "The engineering service could not finish this request.",
      result.status,
    );
  }
  const out = new Headers({
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  for (const key of ["content-type", "content-disposition", "retry-after", "x-assembly-reference"]) {
    const value = result.headers.get(key);
    if (value) out.set(key, value);
  }
  return new Response(result.body, { status: result.status, headers: out });
}

async function handle(request: NextRequest, context: Context) {
  try {
    return await route(request, context);
  } catch (cause) {
    if (cause instanceof QuoteError) return error(cause.message, cause.status);
    return error(
      "The sketch service could not be reached. Reopen the drawing and try again.",
      503,
    );
  }
}

export { handle as GET, handle as POST };
