import { type NextRequest, NextResponse } from "next/server";
import { isHostedPreview } from "./lib/hosted-preview";

export function middleware(request: NextRequest) {
  if (!isHostedPreview()) return NextResponse.next();

  const { pathname } = request.nextUrl;
  const area = pathname.split("/")[1];
  if (area === "api" || !["GET", "HEAD"].includes(request.method)) {
    return NextResponse.json(
      { error: "The hosted preview is read-only. Use the shop desk to save quotes and upload drawings." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const preview = request.nextUrl.clone();
  preview.pathname = "/hosted-preview";
  preview.search = "";
  if (pathname === "/quotes/demo-mounting-plate") preview.searchParams.set("section", "example");
  else if (area) preview.searchParams.set("section", area);
  return NextResponse.rewrite(preview);
}

export const config = {
  runtime: "nodejs",
  matcher: [
    "/", "/api/:path*", "/quotes/:path*", "/blueprints/:path*", "/sketches/:path*",
    "/inbox/:path*", "/jobs/:path*", "/settings/:path*", "/learning/:path*",
  ],
};
