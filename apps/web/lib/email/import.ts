import PostalMime from "postal-mime";
import { createHash, randomUUID } from "node:crypto";
import { getDrawingState, selectDrawingRevision, uploadDrawing, DrawingError } from "../drawings";
import { maxDrawingBytes } from "../drawing-types";
import { createQuote, getQuote, updateQuote, QuoteError } from "../quotes";
import { getQuoteReview } from "../workflow";
import { mailDb, mailTransaction, linkMail, validAddress } from "./store";

export const maxEmailBytes = 32 * 1024 * 1024;
type Source = { account: string; providerId?: string; threadId?: string };
const messageIds = (value?: string) => value?.match(/<[^<>\s\x00-\x1f]{1,600}>/g) ?? [];
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const drawingKey = (name: string) => name.toLowerCase().replace(/\.[^.]+$/, "").replace(/[._ -]*(?:rev(?:ision)?[._ -]*)([a-z]|\d{1,4})$/i, "").trim();

export async function importEmail(raw: Buffer, source: Source = {account:"eml"}) {
  if (!raw.length || raw.length > maxEmailBytes) throw new QuoteError("Choose an email file between 1 byte and 32 MiB.", 413);
  const message = await PostalMime.parse(raw, {maxNestingDepth:64, maxPartCount:1000}).catch(() => {
    throw new QuoteError("The file could not be read as a MIME email.");
  });
  const from = message.from?.address ?? "";
  if (!validAddress(from)) throw new QuoteError("The message needs a valid From address.");
  const reply = message.replyTo?.find(address => address.address && validAddress(address.address))?.address ?? from;
  const rfcId = messageIds(message.messageId)[0] ?? "<" + hash(raw) + "@import.local>";
  const keys = new Set([rfcId, ...messageIds(message.inReplyTo), ...messageIds(message.references)].map(id => "rfc:" + id));
  if (source.threadId) keys.add("gmail:" + source.account + ":" + source.threadId);
  const body = message.text?.trim() || (message.html ?? "").replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,"").replace(/<\/(?:p|div)>|<br\s*\/?>/gi,"\n").replace(/<[^>]*>/g,"").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").trim();
  const subject = message.subject?.trim() || "Customer request";
  const received = message.date && !Number.isNaN(Date.parse(message.date)) ? new Date(message.date).toISOString() : new Date().toISOString();
  // Initialize the existing quoting tables before starting the import transaction.
  getQuote("__mail_schema__");
  return mailTransaction(() => {
    const db = mailDb();
    const duplicate = db.prepare("SELECT id, quote_id FROM mail_messages WHERE rfc_id=? OR (account=? AND provider_id=?)").get(rfcId,source.account,source.providerId ?? null);
    if (duplicate) {
      const quoteId = String(duplicate.quote_id);
      for (const key of keys) linkMail(key,quoteId);
      if (source.providerId) db.prepare("UPDATE mail_messages SET account=?,provider_id=?,thread_id=? WHERE id=? AND provider_id IS NULL").run(source.account,source.providerId,source.threadId ?? null,duplicate.id);
      return {quoteId, messageId:String(duplicate.id), duplicate:true};
    }
    const ids = new Set<string>();
    for (const key of keys) {
      const record = db.prepare("SELECT quote_id FROM mail_links WHERE identifier=?").get(key);
      if (record) ids.add(String(record.quote_id));
    }
    if (ids.size > 1) throw new QuoteError("This message references multiple requests. Its email was left unimported.",409);
    const id = [...ids][0];
    const earlier = id ? getQuote(id) : null;
    const newerDrawing = earlier && db.prepare(`SELECT 1 FROM mail_files f JOIN mail_messages m ON m.id=f.message_id
      WHERE m.quote_id=? AND m.sent_at>? AND f.drawing_revision IS NOT NULL LIMIT 1`).get(id,received);
    const keepRevision = newerDrawing ? getDrawingState(id).selectedRevisionId : null;
    const incomingNotes = body || "[Customer sent an attachment without a message.]";
    // Preserve original correspondence separately when a long thread exceeds the editable notes limit.
    let quote = earlier ?? createQuote({customer:(message.from?.name || from).slice(0,500),jobName:subject.replace(/^(?:re|fwd?):\s*/i,"").slice(0,500),
      notes:incomingNotes.slice(0,50000),marginPercent:25,items:[{id:randomUUID(),description:"Scope pending review",quantity:1,costRows:[]}]});
    if (earlier) {
      const addition = "\n\n" + from + " · " + received.slice(0,10) + "\n" + incomingNotes;
      if (earlier.notes.length < 50000) quote = updateQuote(id,{...earlier,notes:(earlier.notes + addition).slice(0,50000)});
    }
    const messageId = randomUUID();
    db.prepare("INSERT INTO mail_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(messageId,quote.id,rfcId,source.account,source.providerId ?? null,source.threadId ?? null,from,message.from?.name ?? "",reply,subject,body,received,raw);
    for (const key of keys) linkMail(key,quote.id);
    for (const [i, attachment] of message.attachments.entries()) {
      const bytes = typeof attachment.content === "string" ? Buffer.from(attachment.content,attachment.encoding ?? "utf8") : Buffer.from(new Uint8Array(attachment.content));
      const name = (attachment.filename || "Attachment " + (i+1)).split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g,"_").slice(0,240) || "Attachment";
      let revisionId: string | null = null;
      if (!attachment.related && bytes.length && bytes.length <= maxDrawingBytes) {
        const state = getDrawingState(quote.id);
        const group = state.attachments.find(a => a.revisions.some(r => drawingKey(r.fileName) === drawingKey(name)));
        const rev = /[._ -]rev(?:ision)?[._ -]*([a-z]|\d{1,4})(?=\.[^.]+$)/i.exec(name)?.[1]?.toUpperCase() || "";
        const label = group?.revisions.some(r=>r.label.toUpperCase()===rev) ? "" : rev;
        const prior = db.prepare(`SELECT f.drawing_revision FROM mail_files f JOIN mail_messages m ON m.id=f.message_id
          WHERE m.quote_id=? AND f.name=? AND f.original=? AND f.drawing_revision IS NOT NULL LIMIT 1`).get(quote.id,name,bytes);
        if (prior) revisionId = String(prior.drawing_revision);
        else {
          try { revisionId = uploadDrawing(quote.id,{bytes,fileName:name},group?.id ?? "",label).selectedRevisionId; }
          catch (err) { if (!(err instanceof DrawingError && err.status===415)) throw err; }
        }
      }
      db.prepare("INSERT INTO mail_files VALUES (?,?,?,?,?,?)").run(randomUUID(),messageId,name,attachment.mimeType,bytes,revisionId);
    }
    if (keepRevision && getDrawingState(quote.id).selectedRevisionId !== keepRevision) selectDrawingRevision(quote.id,keepRevision);
    return {quoteId:quote.id,messageId,duplicate:false};
  });
}

export function draftClarification(quoteId: string) {
  const {snapshot} = getQuoteReview(quoteId);
  const {quote,details} = snapshot;
  const questions = new Set<string>();
  if (snapshot.reviewRuns.length) {
    for (const question of snapshot.questions) {
      if (!details.resolutions[question.id]?.trim()) questions.add("Please confirm " + question.label + ".");
    }
  } else {
    if (!snapshot.drawing) questions.add("Please send the current drawing and revision.");
    if (!details.scopeConfirmed) questions.add("Please confirm the order quantity, material grade and finish.");
  }
  if (!details.leadTimeConfirmed) questions.add("What delivery date do you need?");
  return "Hello,\n\nThank you for the request for " + quote.jobName + ".\n\n" +
    (questions.size ? [...questions].join("\n") : "Please let us know if the confirmed requirements or delivery date have changed.") +
    "\n\nThank you,\nNick\nLittle Mountain Metalworks";
}

