import { getApprovedPackage } from "@/lib/workflow";
import { QuoteError } from "@/lib/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const search=new URL(request.url).searchParams;
  const version=Number(search.get("version"));
  try{
    if(!Number.isSafeInteger(version)||version<1)throw new QuoteError("Choose an approved quote version.");
    const {pdf,filename}=getApprovedPackage(id,version);
    return new Response(Uint8Array.from(pdf),{headers:{
      "Content-Type":"application/pdf",
      "Content-Disposition":(search.get("download")==="1"?"attachment":"inline")+'; filename="'+filename+'"',
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff",
    }});
  }catch(error){
    if(error instanceof QuoteError)return Response.json({error:error.message},{status:error.status});
    throw error;
  }
}
