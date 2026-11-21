import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { callbackUrl, googleConsent } from "@/lib/email/gmail";
export const dynamic="force-dynamic";
export async function GET(request: Request) {
  const origin=new URL(callbackUrl()).origin;
  const url=new URL(request.url);
  if (url.protocol+"//"+(request.headers.get("host") || url.host)!==origin) return NextResponse.redirect(new URL("/api/inbox/gmail/connect",origin));
  try {
    const state=randomBytes(32).toString("hex");
    const result=NextResponse.redirect(googleConsent(state));
    result.cookies.set("lmm_google_state",state,{httpOnly:true,sameSite:"lax",secure:origin.startsWith("https:"),maxAge:600,path:"/api/inbox/gmail/callback"});
    return result;
  } catch {
    return NextResponse.redirect(new URL("/inbox?error=Set+the+Gmail+OAuth+client+credentials+and+restart+the+app.",origin));
  }
}

