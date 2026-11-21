import { quoteResponse, readJson } from "@/app/api/quotes/_http";
import { engineeringConnection } from "@/lib/engineering-connection";
import { QuoteError } from "@/lib/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function callService(suffix = "", payload?: unknown) {
  const connection = engineeringConnection();
  if (!connection) throw new QuoteError("Connect the engineering desk to manage blueprint rules.", 503);
  let response: Response;
  try {
    response = await fetch(connection.origin + "/v1/catalog/nick-rules" + suffix, {
      method: payload === undefined ? "GET" : "POST",
      headers: {Authorization: "Bearer " + connection.token, "Content-Type": "application/json"},
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
    });
  } catch { throw new QuoteError("Could not reach the engineering desk. Try again.", 503); }
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    const message = typeof result?.detail === "string" ? result.detail :
      response.status === 422 ? "Check the rule, amount, reviewer and reason." : "Could not open the estimating rules.";
    throw new QuoteError(message, response.status);
  }
  return response.json();
}

export function GET(request:Request) { return quoteResponse(() => callService(new URL(request.url).searchParams.get("suggestions")==="1"?"/suggestions":"")); }

export function POST(request: Request) {
  return quoteResponse(async () => {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && new URL(origin).host !== request.headers.get("host"))
      throw new QuoteError("Use the shop settings screen to change rules.", 403);
    if (!request.headers.get("content-type")?.includes("application/json"))
      throw new QuoteError("Send a JSON rule.", 415);
    const input = await readJson(request);
    if (!input || typeof input !== "object" || !("entry" in input)) throw new QuoteError("Choose a rule.");
    if ("key" in input) {
      if (typeof input.key !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.key))
        throw new QuoteError("Choose an existing rule.");
      if ("action" in input && input.action==="decide") return callService("/"+encodeURIComponent(input.key)+"/decision",input.entry);
      return callService("/" + encodeURIComponent(input.key) + "/retire", input.entry);
    }
    return callService("", input.entry);
  });
}
