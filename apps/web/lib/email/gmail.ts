import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { QuoteError } from "../quotes";
import { importEmail } from "./import";
import { mailDb, validAddress } from "./store";

export const callbackUrl = () => process.env.LMM_GMAIL_REDIRECT_URI || "http://127.0.0.1:3100/api/inbox/gmail/callback";
const scopes = ["gmail.readonly","gmail.compose"].map(scope => "https://www.googleapis.com/auth/" + scope);

function credentials() {
  const id = process.env.LMM_GMAIL_CLIENT_ID;
  const secret = process.env.LMM_GMAIL_CLIENT_SECRET;
  if (!id || !secret) throw new QuoteError("Set the Gmail OAuth client ID and secret in .env.local, then restart the app.", 409);
  return {id,secret};
}

export function gmailSettings() {
  const account = mailDb().prepare("SELECT sender,label_name FROM mail_account WHERE id=1").get();
  return { configured: Boolean(process.env.LMM_GMAIL_CLIENT_ID && process.env.LMM_GMAIL_CLIENT_SECRET),
    sender: String(account?.sender ?? ""), label: String(account?.label_name ?? ""), redirectUri:callbackUrl() };
}

export function googleConsent(state: string) {
  const params = new URLSearchParams({client_id:credentials().id,redirect_uri:callbackUrl(),response_type:"code",
    scope:scopes.join(" "),access_type:"offline",prompt:"consent",state});
  return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}

function encryptionKey() {
  return createHash("sha256").update("LMM Gmail refresh token\0" + credentials().secret).digest();
}

function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm",encryptionKey(),iv);
  const data = Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return [iv,cipher.getAuthTag(),data].map(b=>b.toString("base64url")).join(".");
}

function unseal(value: string) {
  const [iv,tag,data] = value.split(".").map(b=>Buffer.from(b,"base64url"));
  try {
    const decipher = createDecipheriv("aes-256-gcm",encryptionKey(),iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8");
  } catch { throw new QuoteError("Reconnect Gmail after changing the OAuth client secret.",409); }
}

async function tokenExchange(params: Record<string,string>) {
  const {id,secret} = credentials();
  const response = await fetch("https://oauth2.googleapis.com/token",{method:"POST",cache:"no-store",redirect:"error",
    signal:AbortSignal.timeout(20000),body:new URLSearchParams({...params,client_id:id,client_secret:secret})});
  if (!response.ok) throw new QuoteError("Google could not authorize this request. Check the OAuth client and reconnect Gmail.",409);
  return await response.json() as {access_token?:string;refresh_token?:string;scope?:string};
}

export class GmailError extends Error {
  constructor(public httpStatus: number) { super("Gmail returned HTTP " + httpStatus + "."); }
}

function gmailApi(token: string) {
  return async function request<T>(path:string,body?:object):Promise<T> {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path,{
      method:body ? "POST":"GET",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{Authorization:"Bearer " + token,...(body ? {"Content-Type":"application/json"} : {})},body:body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw new GmailError(response.status);
    return await response.json() as T;
  };
}

export async function finishConsent(code: string) {
  const tokens = await tokenExchange({code,grant_type:"authorization_code",redirect_uri:callbackUrl()});
  if (!tokens.access_token || !tokens.refresh_token || !scopes.every(s=>tokens.scope?.split(" ").includes(s))) {
    throw new QuoteError("Approve both Gmail permissions and allow offline access when connecting.",409);
  }
  const account = await gmailApi(tokens.access_token)<{emailAddress:string}>("profile");
  if (!validAddress(account.emailAddress)) throw new QuoteError("Google returned an invalid sender address.");
  mailDb().prepare(`INSERT INTO mail_account(id,sender,sealed_refresh) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET sealed_refresh=excluded.sealed_refresh,sender=excluded.sender,
    label_id=CASE WHEN mail_account.sender=excluded.sender THEN label_id ELSE '' END,
    label_name=CASE WHEN mail_account.sender=excluded.sender THEN label_name ELSE '' END`).run(account.emailAddress,seal(tokens.refresh_token));
}

export async function gmailSession() {
  const account = mailDb().prepare("SELECT * FROM mail_account WHERE id=1").get();
  if (!account) throw new QuoteError("Connect the quoting Gmail account first.",409);
  const tokens = await tokenExchange({refresh_token:unseal(String(account.sealed_refresh)),grant_type:"refresh_token"});
  if (!tokens.access_token) throw new QuoteError("Reconnect the quoting Gmail account.",409);
  return {sender:String(account.sender),label:String(account.label_id),request:gmailApi(tokens.access_token)};
}

export async function selectGmailLabel(name: string) {
  const session = await gmailSession();
  const list = await session.request<{labels:{name:string;id:string}[]}>("labels");
  const selected = list.labels.find(label=>label.name.toLowerCase()===name.trim().toLowerCase());
  if (!selected) throw new QuoteError("Enter the name of an existing quoting label in this Gmail account.");
  mailDb().prepare("UPDATE mail_account SET label_id=?,label_name=? WHERE sender=?").run(selected.id,selected.name,session.sender);
  return selected.name;
}

export async function importLabel() {
  const session = await gmailSession();
  if (!session.label) throw new QuoteError("Select the quoting label before importing.",409);
  const db = mailDb();
  const ids: string[] = [];
  let page = "";
  do {
    const q = new URLSearchParams({labelIds:session.label,q:"-in:sent -in:drafts",maxResults:"500"});
    if (page) q.set("pageToken",page);
    const list = await session.request<{nextPageToken?:string;messages?:{id:string}[]}>("messages?" + q);
    for (const message of list.messages ?? []) if (!db.prepare("SELECT 1 FROM mail_messages WHERE account=? AND provider_id=?").get(session.sender,message.id)) ids.push(message.id);
    page = list.nextPageToken ?? "";
  } while (page);
  let imported=0, failed=0;
  for (const id of ids.reverse()) {
    try {
      const message = await session.request<{id:string;threadId:string;raw:string;labelIds:string[]}>("messages/" + encodeURIComponent(id) + "?format=raw");
      if (!message.labelIds.includes(session.label) || message.labelIds.includes("SENT") || message.labelIds.includes("DRAFT")) continue;
      const result = await importEmail(Buffer.from(message.raw,"base64url"),{account:session.sender,providerId:id,threadId:message.threadId});
      if (!result.duplicate) imported++;
    } catch { failed++; }
  }
  return {imported,failed};
}

