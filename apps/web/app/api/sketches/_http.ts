import { QuoteError } from "@/lib/quotes";

export async function sketchResponse(
  action: () => unknown | Promise<unknown>,
  status = 200,
) {
  try {
    const result = await action();
    return result instanceof Response
      ? result
      : Response.json(result, {
          status,
          headers: { "Cache-Control": "no-store" },
        });
  } catch (error) {
    if (error instanceof QuoteError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error(
      "Sketch request failed",
      error instanceof Error ? error.name : "Unknown error",
    );
    return Response.json(
      { error: "Could not finish this sketch request. Try again." },
      { status: 500 },
    );
  }
}

export function sketchVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new QuoteError("Choose a saved version of this sketch.");
  }
  return value;
}

export function fileResponse(
  data: Buffer | string,
  mime: string,
  name?: string,
) {
  const filename =
    name &&
    encodeURIComponent(name).replace(
      /['()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16),
    );
  return new Response(typeof data === "string" ? data : new Uint8Array(data), {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(filename
        ? { "Content-Disposition": `attachment; filename*=UTF-8''${filename}` }
        : {}),
    },
  });
}
