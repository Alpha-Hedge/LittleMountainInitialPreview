import { engineeringConnection } from "@/lib/engineering-connection";
import { createBlueprintDraft } from "@/lib/blueprint-draft";
import { QuoteError } from "@/lib/quotes";
import type { BlueprintJob } from "@/lib/blueprint-types";
import { blueprintLearningContext } from "@/lib/blueprint-history";
import { getEstimatingSettings } from "@/lib/estimating";
import { after } from "next/server";
import { claimAutomaticBudget } from "@/lib/drawing-takeoff";
import { getWorkflowStatus } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Params = { params: Promise<{ path: string[] }> };
const uuid = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const jobs = new RegExp("^jobs/(" + uuid + ")(?:/(review|retry|draft|manual-draft|proof|source-check))?$");
const sources = new RegExp("^drawings/(" + uuid + ")/(source|preview)$");
const responseError = (detail: string, status: number) =>
  Response.json({ detail }, { status });

async function handle(request: Request, context: Params) {
  const path = (await context.params).path.join("/");
  const get = request.method === "GET";
  const shopFile=new RegExp("^jobs/"+uuid+"/shop-files/[1-9][0-9]{0,8}/(?:0|[1-9][0-9]?)$").test(path);
  const job = jobs.exec(path),
    source = sources.exec(path);
  if (
    !(
      path === "jobs" ||
      (path === "settings" && get) ||
      (path === "drawings" && !get) ||
      (job && (get ? !job[2] : !!job[2])) ||
      ((source || shopFile) && get)
    )
  )
    return responseError("Page unavailable.", 404);
  const connection = engineeringConnection();
  if (!connection)
    return responseError(
      "Open the shop desk connected to Engineering Records to use blueprint estimates.",
      503,
    );
  const origin = request.headers.get("origin");
  if (
    !get &&
    origin &&
    new URL(origin).origin !== new URL(request.url).origin &&
    new URL(origin).host !== request.headers.get("host")
  )
    return responseError("Use your quote desk to make this change.", 403);
  const headers = { Authorization: "Bearer " + connection.token };
  const upstream = (route: string, init?: RequestInit) =>
    fetch(connection.origin + route, {
      ...init,
      headers: { ...headers, ...init?.headers },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
  try {
    if (job?.[2] === "draft" || job?.[2] === "manual-draft") {
      const manual = job[2] === "manual-draft";
      const { version, prepareOnly } = await request.json();
      const details = await upstream("/v1/blueprints/jobs/" + job[1]);
      if (!details.ok)
        return responseError("Estimate unavailable.", details.status);
      const record = (await details.json()) as BlueprintJob;
      if (record.version !== version || (manual ? record.state !== "review_required" || !record.ast : record.state !== "ready"))
        return responseError("Reopen the current completed estimate.", 409);
      let bytes: Buffer | undefined;
      if (record.drawing.type === "CUSTOMER_PDF") {
        const file = await upstream(
          "/v1/drawings/" + record.drawing.id + "/source",
        );
        if (!file.ok)
          return responseError("The saved drawing is unavailable.", 503);
        bytes = Buffer.from(await file.arrayBuffer());
      }
      const draft = createBlueprintDraft(record, bytes, manual);
      if (manual && bytes && prepareOnly !== true && getWorkflowStatus(draft.id,draft.version) === "draft") {
        const task = claimAutomaticBudget(draft.id,draft.version);
        if (task) after(task);
      }
      return Response.json({ id: draft.id, number: draft.number });
    }
    let route = source?.[2] === "source"
      ? "/v1/drawings/" + source[1] + "/source"
      : "/v1/blueprints/" + path;
    if (source?.[2] === "preview") route += "?page="+encodeURIComponent(new URL(request.url).searchParams.get("page") || "1");
    if (path === "drawings") {
      const from = new URL(request.url).searchParams,
        query = new URLSearchParams();
      for (const field of ["filename", "drawing_key", "revision"])
        query.set(field, from.get(field) || "");
      route += "?" + query;
    }
    const init: RequestInit & { duplex?: "half" } = { method: request.method };
    if (!get && (path === "jobs" || job?.[2] === "review")) {
      const body = await request.json();
      if (path === "jobs" && body.settings == null) {
        const defaults = await upstream("/v1/blueprints/settings");
        if (!defaults.ok) return responseError("Could not open the default drawing rate card.",defaults.status);
        const preset = await defaults.json();
        body.settings = {...preset, gross_margin_pct:getEstimatingSettings().defaultMargin ?? preset.gross_margin_pct};
      }
      init.body = JSON.stringify({ ...body, ...(body.save_only === true ? {} : await blueprintLearningContext()) });
      init.headers = { "Content-Type": "application/json" };
    } else if (!get) {
      init.body = request.body;
      init.duplex = "half";
      init.headers = {
        "Content-Type":
          request.headers.get("content-type") || "application/json",
      };
    }
    const result = await upstream(route, init);
    if (get && path === "settings" && result.ok) {
      const preset = await result.json();
      return Response.json({...preset,gross_margin_pct:getEstimatingSettings().defaultMargin ?? preset.gross_margin_pct},
        {headers:{"cache-control":"private, no-store"}});
    }
    const type = result.headers.get("content-type") || "application/json";
    const outgoing = new Headers({
      "content-type": type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    const disposition = result.headers.get("content-disposition");
    if (result.headers.has("x-page-count")) outgoing.set("x-page-count",result.headers.get("x-page-count")!);
    if (result.headers.has("x-profile-frames")) outgoing.set("x-profile-frames",result.headers.get("x-profile-frames")!);
    if (shopFile && disposition)outgoing.set("content-disposition",disposition);
    if (source && disposition)
      outgoing.set(
        "content-disposition",
        type.startsWith("application/pdf")
          ? disposition.replace(/^attachment/, "inline")
          : disposition,
      );
    if (source)
      outgoing.set("content-security-policy", "sandbox; default-src 'none'");
    return new Response(result.body, {
      status: result.status,
      headers: outgoing,
    });
  } catch (error) {
    if (error instanceof QuoteError)
      return responseError(error.message, error.status);
    return responseError(
      "Engineering Records is unavailable. Reopen the saved estimate and try again.",
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
