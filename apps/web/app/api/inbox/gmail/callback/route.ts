import { NextRequest, NextResponse } from "next/server";
import { callbackUrl, finishConsent } from "@/lib/email/gmail";
import { QuoteError } from "@/lib/quotes";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest) {
  const back=new URL("/inbox",callbackUrl());
  const state=request.cookies.get("lmm_google_state")?.value;
  try {
    if (!state || state!==request.nextUrl.searchParams.get("state")) throw new QuoteError("The Gmail connection request expired. Start it again.");
    const code=request.nextUrl.searchParams.get("code");
    if (!code) throw new QuoteError("Google did not grant access. Connect the intended sender when ready.");
    await finishConsent(code);
    back.searchParams.set("notice","Connected Gmail. Choose the quoting label to import.");
  } catch(error) {
    back.searchParams.set("error",error instanceof QuoteError ? error.message:"Gmail authorization failed. Check the registered redirect address and permissions.");
  }
  const result=NextResponse.redirect(back);
  result.cookies.set("lmm_google_state","",{path:"/api/inbox/gmail/callback",maxAge:0});
  return result;
}

