import { randomUUID } from "node:crypto";
import { getQuote, QuoteError } from "../quotes";
import { getApprovedPackage, getWorkflowStatus, recordQuoteSent } from "../workflow";
import { gmailSession, GmailError } from "./gmail";
import { linkMail, mailDb, mailTransaction, testRecipient, testSender, validAddress } from "./store";

export type Channel = "gmail" | "test";
type Receipt = {id:string;threadId?:string};
type Payload = {rfcId:string;raw:Buffer;threadId:string|null};
export interface MailProvider {
  sender:string;
  lookup(rfcId:string):Promise<Receipt|null>;
  prepare(payload:Payload):Promise<string>;
  draftExists(draftId:string):Promise<boolean>;
  dispatch(draftId:string,payload:Payload):Promise<Receipt>;
}

export const localMailbox: MailProvider = {
  sender:testSender,
  async lookup(rfcId) {
    const item = mailDb().prepare("SELECT receipt FROM mail_test_mailbox WHERE rfc_id=?").get(rfcId);
    return item ? {id:String(item.receipt)} : null;
  },
  async prepare(payload) { return payload.rfcId; },
  async draftExists(draftId) { return !(await this.lookup(draftId)); },
  async dispatch(_draftId,payload) {
    const receipt = "local-" + randomUUID();
    mailDb().prepare("INSERT INTO mail_test_mailbox VALUES(?,?,?,?,?)").run(receipt,payload.rfcId,testRecipient,payload.raw,new Date().toISOString());
    return {id:receipt};
  },
};

async function gmailProvider():Promise<MailProvider> {
  const {request,sender} = await gmailSession();
  const search = (rfcId:string) => new URLSearchParams({q:"rfc822msgid:" + rfcId,maxResults:"1"}).toString();
  const message = (payload:Payload) => ({raw:payload.raw.toString("base64url"),...(payload.threadId ? {threadId:payload.threadId}:{})});
  return {sender,
    async lookup(rfcId) {
      const result = await request<{messages?:Receipt[]}>("messages?labelIds=SENT&" + search(rfcId));
      return result.messages?.[0] ?? null;
    },
    async prepare(payload) {
      const prior = await request<{drafts?:{id:string}[]}>("drafts?" + search(payload.rfcId));
      if (prior.drafts?.length) return prior.drafts[0].id;
      const draft = await request<{id:string}>("drafts",{message:message(payload)});
      return draft.id;
    },
    async draftExists(id) {
      try { await request("drafts/" + encodeURIComponent(id) + "?format=minimal"); return true; }
      catch (error) { if (error instanceof GmailError && error.httpStatus===404) return false; throw error; }
    },
    async dispatch(id,payload) {
      // Use the persisted approved MIME even if someone edited the draft in Gmail.
      return await request<Receipt>("drafts/send",{id,message:message(payload)});
    }
  };
}

function encodedSubject(value:string) {
  const chunks:string[] = [];
  let chunk="";
  for (const char of value.replace(/[\r\n]/g," ")) {
    if (Buffer.byteLength(chunk + char)>42) { chunks.push(chunk); chunk=""; }
    chunk+=char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(s=>"=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=").join("\r\n ");
}

function folded(value:Buffer) { return value.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? ""; }

function currentApproval(id:string,version:number) {
  if (getQuote(id)?.version!==version || getWorkflowStatus(id,version)!=="approved") {
    throw new QuoteError("Only the current, unexpired approved version can be sent.",409);
  }
}

function reserve(id:string,version:number,channel:Channel,recipient:string,sender:string,checkOnly:boolean) {
  return mailTransaction(()=>{
    const db=mailDb();
    const select = db.prepare("SELECT * FROM mail_outbox WHERE quote_id=? AND version=? AND channel=?");
    const existing = select.get(id,version,channel);
    if (existing) {
      if (existing.recipient!==recipient || existing.sender!==sender) throw new QuoteError("This delivery already has a sender and recipient. Use its original account and address.",409);
      return existing;
    }
    if (checkOnly) throw new QuoteError("This version has no delivery to check.",404);
    currentApproval(id,version);
    const pkg=getApprovedPackage(id,version);
    const prior=db.prepare(`SELECT * FROM mail_messages WHERE quote_id=? AND lower(reply_to)=lower(?)
        ORDER BY sent_at DESC LIMIT 1`).get(id,recipient);
    const threadId=prior && prior.account===sender ? prior.thread_id : null;
    const uuid=randomUUID();
    const rfcId="<" + uuid + "@" + sender.split("@")[1] + ">";
    const boundary="lmm_" + uuid;
    const title=prior ? "Re: " + String(prior.subject).replace(/^(?:re:\s*)+/i,"") : pkg.quote.number + " · " + pkg.customer.jobName;
    const body="Hello,\n\nPlease find the approved Little Mountain Metalworks quote for " + pkg.customer.jobName +
      " attached (" + pkg.quote.number + ", version " + version + "). It is valid through " + pkg.customer.expiresOn +
      ".\n\nThank you,\nNick\nLittle Mountain Metalworks";
    const raw=Buffer.from(["From: Little Mountain Metalworks <" + sender + ">","To: " + recipient,
      "Date: " + new Date().toUTCString(),"Message-ID: " + rfcId,"Subject: " + encodedSubject(title),
      ...(prior ? ["In-Reply-To: " + prior.rfc_id,"References: " + prior.rfc_id]:[]),
      "MIME-Version: 1.0",'Content-Type: multipart/mixed; boundary="' + boundary + '"',"","--" + boundary,
      "Content-Type: text/plain; charset=UTF-8","Content-Transfer-Encoding: base64","",folded(Buffer.from(body)),
      "--" + boundary,"Content-Type: application/pdf",'Content-Disposition: attachment; filename="' + pkg.filename + '"',
      "Content-Transfer-Encoding: base64","",folded(pkg.pdf),"--" + boundary + "--",""].join("\r\n"));
    db.prepare(`INSERT INTO mail_outbox(id,quote_id,version,channel,recipient,sender,rfc_id,thread_id,raw,status,updated)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?)`).run(uuid,id,version,channel,recipient,sender,rfcId,threadId,raw,new Date().toISOString());
    return select.get(id,version,channel)!;
  });
}

export async function sendApproved(id:string,version:number,recipient:string,channel:Channel,checkOnly=false,transport?:MailProvider) {
  recipient=recipient.trim();
  if (!validAddress(recipient) || !["gmail","test"].includes(channel)) throw new QuoteError("Choose a sender and enter one valid recipient address.");
  if (channel==="test" && recipient!==testRecipient) throw new QuoteError("The local mailbox accepts only " + testRecipient + ".");
  const known=mailDb().prepare("SELECT status,receipt,recipient FROM mail_outbox WHERE quote_id=? AND version=? AND channel=?").get(id,version,channel);
  if (known?.status==="sent" && known.recipient===recipient) return {status:"sent",receipt:String(known.receipt)};
  const provider=transport ?? (channel==="test" ? localMailbox : await gmailProvider());
  const entry=reserve(id,version,channel,recipient,provider.sender,checkOnly);
  if (entry.status==="sent") return {status:"sent",receipt:String(entry.receipt)};
  const db=mailDb();
  const lease=randomUUID();
  const now=Date.now();
  const locked=db.prepare("UPDATE mail_outbox SET lease=?,lease_until=? WHERE id=? AND receipt IS NULL AND (lease IS NULL OR lease_until<?)").run(lease,now+180000,entry.id,now);
  if (!locked.changes) throw new QuoteError("A delivery check is running. Check this delivery again for the receipt.",409);
  const payload:Payload={rfcId:String(entry.rfc_id),raw:Buffer.from(entry.raw as Uint8Array),threadId:entry.thread_id ? String(entry.thread_id):null};
  const complete=(receipt:Receipt)=>{
    if (!receipt.id) throw new Error("Incomplete provider receipt.");
    return mailTransaction(()=>{
      if (channel==="gmail") {
        recordQuoteSent(id,version,receipt.id);
        linkMail("rfc:" + payload.rfcId,id);
        if (receipt.threadId) linkMail("gmail:" + provider.sender + ":" + receipt.threadId,id);
      }
      db.prepare("UPDATE mail_outbox SET receipt=?,status='sent',detail='',updated=? WHERE id=?").run(receipt.id,new Date().toISOString(),entry.id);
      return {status:"sent",receipt:receipt.id};
    });
  };
  try {
    // A receipt may arrive after the prior process lost its connection, even after a revision.
    const prior=await provider.lookup(payload.rfcId);
    if (prior) return complete(prior);
    let draftId=entry.draft_id ? String(entry.draft_id):"";
    if (draftId && !(await provider.draftExists(draftId))) throw new QuoteError("Gmail has consumed the draft. Check again for the sent receipt before retrying.",409);
    if (checkOnly) return {status:"pending",receipt:""};
    currentApproval(id,version);
    if (!draftId) {
      draftId=await provider.prepare(payload);
      if (!draftId) throw new Error("Incomplete provider draft.");
      db.prepare("UPDATE mail_outbox SET draft_id=? WHERE id=? AND lease=?").run(draftId,entry.id,lease);
    }
    currentApproval(id,version);
    const updated=db.prepare("UPDATE mail_outbox SET status='dispatching',updated=? WHERE id=? AND lease=? AND lease_until>?").run(new Date().toISOString(),entry.id,lease,Date.now());
    if (!updated.changes) throw new QuoteError("This attempt timed out. Check delivery before trying again.",409);
    return complete(await provider.dispatch(draftId,payload));
  } catch (error) {
    const detail = error instanceof QuoteError ? error.message : "Provider receipt unavailable. Check delivery before retrying.";
    db.prepare("UPDATE mail_outbox SET status='uncertain',detail=?,updated=? WHERE id=? AND lease=? AND receipt IS NULL").run(detail,new Date().toISOString(),entry.id,lease);
    throw new QuoteError(detail,409);
  } finally { db.prepare("UPDATE mail_outbox SET lease=NULL,lease_until=0 WHERE id=? AND lease=?").run(entry.id,lease); }
}

