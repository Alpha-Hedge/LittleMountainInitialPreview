import { quoteResponse, readJson } from "@/app/api/quotes/_http";
import { QuoteError } from "@/lib/quotes";
import { changeWorkflow, getQuoteReview } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{id:string}>};

export async function GET(request:Request,{params}:Context){
  const {id}=await params;
  return quoteResponse(()=>{
    const raw=new URL(request.url).searchParams.get("version");
    if(raw!==null && (!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<1))
      throw new QuoteError("Choose a saved quote version.");
    return getQuoteReview(id,raw===null ? undefined:Number(raw));
  });
}
export async function POST(request:Request,{params}:Context){
  const {id}=await params;
  return quoteResponse(async()=>changeWorkflow(id,await readJson(request)));
}
