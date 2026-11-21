import { workspaceRoot } from "@/lib/workspace-root";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getQuote, QuoteError } from "@/lib/quotes";
import { sendApproved, type Channel } from "@/lib/email/delivery";
import { importEmail, maxEmailBytes, draftClarification } from "@/lib/email/import";
import { importLabel, selectGmailLabel } from "@/lib/email/gmail";
import { mailDb, testRecipient } from "@/lib/email/store";

export const runtime="nodejs";
export async function POST(request:Request) {
  const requestUrl=new URL(request.url);
  const origin=requestUrl.protocol+"//"+(request.headers.get("host") || requestUrl.host);
  if ((request.headers.get("origin") && request.headers.get("origin")!==origin) || request.headers.get("sec-fetch-site")==="cross-site") {
    return Response.json({error:"Use the quoting workspace to submit this form."},{status:403});
  }
  const target=new URL("/inbox",origin);
  const json=request.headers.get("accept")?.includes("application/json");
  try {
    if (Number(request.headers.get("content-length") || 0)>maxEmailBytes+65536) throw new QuoteError("Choose an email up to 32 MiB.",413);
    const form=await request.formData();
    const value=(key:string)=>String(form.get(key) ?? "");
    const id=value("quoteId");
    const version=Number(value("version"));
    if (id) target.searchParams.set("quoteId",id);
    if (version>0) target.searchParams.set("version",String(version));
    let notice="";
    switch(value("action")){
      case "upload":
      case "sample":
      case "revision": {
        let bytes:Buffer;
        if (value("action")==="upload") {
          const file=form.get("file");
          if (!(file instanceof File) || !file.size || file.size>maxEmailBytes) throw new QuoteError("Choose a .eml file up to 32 MiB.");
          bytes=Buffer.from(await file.arrayBuffer());
        } else {
          const sample=value("action")==="sample" ? "request.eml":"revision.eml";
          bytes=await readFile(path.join(workspaceRoot(),"fixtures","mail",sample));
        }
        const result=await importEmail(bytes);
        target.searchParams.set("quoteId",result.quoteId);
        target.searchParams.delete("version");
        notice=result.duplicate ? "This message was already imported." : "Imported the message and linked its files.";
        break;
      }
      case "selectLabel": notice="Selected Gmail label " + await selectGmailLabel(value("label")) + "."; break;
      case "sync": {
        const {imported,failed}=await importLabel();
        notice="Imported " + imported + " new messages." + (failed ? " " + failed + " failed and can be retried." : "");
        break;
      }
      case "draft":
      case "saveDraft": {
        if (!getQuote(id)) throw new QuoteError("Request not found.",404);
        const body=value("action")==="draft" ? draftClarification(id) : value("body").trim();
        if (!body || body.length>50000) throw new QuoteError("Enter a clarification reply up to 50,000 characters.");
        mailDb().prepare("INSERT INTO mail_clarifications VALUES(?,?,?) ON CONFLICT(quote_id) DO UPDATE SET body=excluded.body,updated=excluded.updated").run(id,body,new Date().toISOString());
        notice="Saved the clarification draft.";
        break;
      }
      case "send":
      case "check": {
        const channel=value("channel") as Channel;
        const result=await sendApproved(id,version,channel==="test" ? testRecipient:value("recipient"),channel,value("action")==="check");
        notice=result.receipt ? (channel==="test" ? "Captured once in the local test mailbox.":"Gmail accepted the approved quote.") :
          "No sent receipt yet. The original attempt can be retried while its draft is available.";
        break;
      }
      default: throw new QuoteError("Unknown inbox action.");
    }
    target.searchParams.set("notice",notice);
    if (json) return Response.json({notice,quoteId:target.searchParams.get("quoteId")});
  } catch(error) {
    const message=error instanceof QuoteError ? error.message : "The mail operation failed. Check the connection and try again.";
    if (json) return Response.json({error:message},{status:error instanceof QuoteError ? error.status:502});
    target.searchParams.set("error",message);
  }
  return new Response(null,{status:303,headers:{Location:target.pathname+target.search}});
}

