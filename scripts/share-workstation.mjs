import { timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";

const key = process.env.LMM_SHARE_ORIGIN_KEY;
const publicOrigin = new URL(process.env.LMM_SHARE_PUBLIC_ORIGIN || "https://littlemountaininitialpreview.vercel.app");
const port = Number(process.env.LMM_SHARE_LOCAL_PORT || "3108");
const workstation = new URL("http://127.0.0.1:3100");

if (!/^[a-f0-9]{64}$/.test(key || "") || publicOrigin.protocol !== "https:") {
  throw Error("Set the private origin key and HTTPS share address before starting the desk relay.");
}

const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function filtered(headers) {
  const connected = new Set(String(headers.connection || "").toLowerCase().split(",").map((name) => name.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !connected.has(name)));
}

createServer((incoming, outgoing) => {
  const token = incoming.headers["x-lmm-desk-origin"];
  const unsafe = incoming.method !== "GET" && incoming.method !== "HEAD";
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(key, "hex")) ||
      (unsafe && incoming.headers.origin !== publicOrigin.origin) || !incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
    outgoing.writeHead(403, { "Cache-Control": "no-store" }).end();
    return;
  }

  const headers = filtered(incoming.headers);
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-forwarded-") || name.startsWith("x-middleware-") || name.startsWith("x-lmm-") ||
        name === "authorization" || name === "cookie" || name === "forwarded") delete headers[name];
  }
  headers.host = publicOrigin.host;
  headers["x-forwarded-host"] = publicOrigin.host;
  headers["x-forwarded-proto"] = "https";

  const upstream = request(workstation, { method: incoming.method, path: incoming.url, headers }, (response) => {
    const resultHeaders = filtered(response.headers);
    if (resultHeaders.location) {
      const target = new URL(resultHeaders.location, publicOrigin);
      if (target.origin === workstation.origin) resultHeaders.location = target.pathname + target.search + target.hash;
    }
    outgoing.writeHead(response.statusCode || 502, {
      ...resultHeaders, "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow",
    });
    response.on("error", () => outgoing.destroy());
    response.pipe(outgoing);
  });
  outgoing.on("close", () => upstream.destroy());
  incoming.on("error", () => upstream.destroy());
  upstream.on("error", () => {
    if (outgoing.headersSent) outgoing.destroy();
    else outgoing.writeHead(502, { "Cache-Control": "no-store" }).end("The shop desk is offline.");
  });
  incoming.pipe(upstream);
}).listen(port, "127.0.0.1", () => console.log(`Shop desk relay listening on 127.0.0.1:${port}`));
