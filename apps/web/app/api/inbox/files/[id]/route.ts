import { mailDb } from "@/lib/email/store";
export const dynamic="force-dynamic";
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
  const {id}=await context.params;
  const kind=new URL(request.url).searchParams.get("kind");
  const db=mailDb();
  const file=kind==="message" ? db.prepare("SELECT 'customer-message.eml' AS name, raw AS bytes FROM mail_messages WHERE id=?").get(id)
    : kind==="capture" ? db.prepare("SELECT 'captured-quote.eml' AS name,raw AS bytes FROM mail_test_mailbox WHERE receipt=?").get(id)
    : db.prepare("SELECT name,original AS bytes FROM mail_files WHERE id=?").get(id);
  if (!file) return Response.json({error:"File not found."},{status:404});
  const name=encodeURIComponent(String(file.name)).replace(/['()*]/g,c=>"%"+c.charCodeAt(0).toString(16));
  return new Response(new Uint8Array(file.bytes as Uint8Array),{headers:{"Content-Disposition":"attachment; filename*=UTF-8''"+name,
    "Content-Type":"application/octet-stream","X-Content-Type-Options":"nosniff","Cache-Control":"no-store"}});
}

