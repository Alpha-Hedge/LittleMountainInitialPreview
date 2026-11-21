import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

const cookieName = "__Host-lmm-desk";
const invitePath = "/desk-access";
const weekSeconds = 7 * 24 * 60 * 60;
const idlePageHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};
const accessScript = `
const ticket = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(ticket)) {
  history.replaceState(null, '', location.pathname);
  fetch(location.pathname, {method: 'POST', headers: {'X-LMM-Invitation': ticket}})
    .then(response => {
      if (!response.ok) throw new Error();
      location.replace('/');
    })
    .catch(() => document.querySelector('p').textContent = 'This invitation could not open. Ask for the full link again.');
} else document.querySelector('p').textContent = 'Use the full invitation link to open the shop desk.';`;
const scriptHash = createHash("sha256").update(accessScript).digest("base64");

function accessPage(view: "legacy" | "locked" | "guest") {
  const message = view === "legacy" ? "Opening the desk with your invitation…"
    : view === "guest" ? "Your shop desk is ready to open." : "Use the full invitation link to open the shop desk.";
  return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Little Mountain Metalworks</title>
<style>body{margin:0;background:#f2f6fb;color:#182638;font:17px/1.6 system-ui}main{max-width:32rem;margin:14vh auto;padding:2rem}h1{line-height:1.15}a{display:inline-block;padding:.7rem 1.2rem;background:#075bb5;color:white;border-radius:.55rem;font-weight:600;text-decoration:none}</style>
</head><body><main><h1>Little Mountain Metalworks</h1><p role="status">${message}</p>
${view === "guest" ? '<a href="/">Open quote desk</a>' : ""}</main>
${view === "legacy" ? `<script>${accessScript}</script>` : ""}</body></html>`, {
    status: view === "locked" ? 401 : 200,
    headers: {
      ...idlePageHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    },
  });
}

function equalHex(expected: string, provided: string | null | undefined) {
  return Boolean(provided && /^[a-f0-9]{64}$/.test(provided) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex")));
}

function setSession(response: NextResponse, session: string) {
  response.cookies.set(cookieName, session, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: weekSeconds });
  return response;
}

function validLink(expires: string | null, signature: string | null, originKey: string, inviteHash: string) {
  if (expires === null || !/^\d{10}$/.test(expires)) return false;
  const now = Math.floor(Date.now() / 1000);
  const deadline = Number(expires);
  if (deadline < now || deadline > now + weekSeconds) return false;
  const expected = createHmac("sha256", originKey).update(`lmm-desk-link:${inviteHash}:${expires}`).digest("hex");
  return equalHex(expected, signature);
}

export function shareWorkstation(request: NextRequest): NextResponse | null {
  const endpoint = process.env.LMM_SHARE_ENDPOINT;
  const publicOrigin = process.env.LMM_SHARE_PUBLIC_ORIGIN;
  const originKey = process.env.LMM_SHARE_ORIGIN_KEY;
  const inviteHash = process.env.LMM_SHARE_INVITE_HASH;
  if (!endpoint || !publicOrigin || !originKey || !inviteHash) return null;
  const destination = new URL(endpoint);
  if (request.nextUrl.host !== new URL(publicOrigin).host) return null;
  if (destination.protocol !== "https:" || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(destination.host) ||
      destination.username || destination.password || !/^[a-f0-9]{64}$/.test(originKey) || !/^[a-f0-9]{64}$/.test(inviteHash)) {
    return new NextResponse("The shop desk invitation is unavailable.", { status: 503, headers: idlePageHeaders });
  }

  const { pathname, search } = request.nextUrl;
  const session = createHmac("sha256", originKey).update(inviteHash).digest("hex");
  const guest = /^\/invite\/(\d{10})-([a-f0-9]{64})$/.exec(pathname);
  if (guest) {
    if (request.method !== "GET" || !validLink(guest[1], guest[2], originKey, inviteHash)) return accessPage("locked");
    return setSession(accessPage("guest"), session);
  }
  if (pathname === invitePath) {
    if (request.method === "GET") {
      const expires = request.nextUrl.searchParams.get("expires");
      const signature = request.nextUrl.searchParams.get("signature");
      if (expires === null && signature === null) return accessPage("legacy");
      if (!validLink(expires, signature, originKey, inviteHash)) return accessPage("locked");
      return setSession(NextResponse.redirect(new URL("/", publicOrigin), { status: 303, headers: idlePageHeaders }), session);
    }
    const invitation = request.headers.get("X-LMM-Invitation");
    if (request.method !== "POST" || request.headers.get("Origin") !== publicOrigin || !invitation ||
        !/^[a-f0-9]{64}$/.test(invitation) || !equalHex(inviteHash, createHash("sha256").update(invitation).digest("hex"))) {
      return new NextResponse(null, { status: 403, headers: idlePageHeaders });
    }
    return setSession(new NextResponse(null, { status: 204, headers: idlePageHeaders }), session);
  }

  if (!equalHex(session, request.cookies.get(cookieName)?.value)) {
    return pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Open the desk from your invitation link." }, { status: 401, headers: idlePageHeaders })
      : accessPage("locked");
  }
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Origin") !== publicOrigin) {
    return new NextResponse(null, { status: 403, headers: idlePageHeaders });
  }

  destination.pathname = pathname;
  destination.search = search;
  const headers = new Headers(request.headers);
  headers.set("X-LMM-Desk-Origin", originKey);
  headers.delete("cookie");
  headers.delete("authorization");
  return NextResponse.rewrite(destination, { request: { headers }, headers: idlePageHeaders });
}
