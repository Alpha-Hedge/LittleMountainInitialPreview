import { after } from "next/server";
import { applyTakeoff, automaticBudgetState, buildTakeoff, claimAutomaticBudget } from "@/lib/drawing-takeoff";
import { quoteResponse, readJson } from "../../_http";
import { checkDeskOrigin } from "../../../assistant/_http";

export const runtime = "nodejs";

type Context = {params: Promise<{id: string}>};

export function GET(_request: Request, context: Context) {
  return quoteResponse(async ()=>automaticBudgetState((await context.params).id));
}

export function POST(request: Request, context: Context) {
  return quoteResponse(async ()=>{
    checkDeskOrigin(request);
    const id = (await context.params).id;
    const input = await readJson(request) as {automatic?:boolean; version:number; retry?:boolean} | null;
    if (input?.automatic === true) {
      const state = automaticBudgetState(id);
      if (state.state === "ready") return state;
      const task = claimAutomaticBudget(id,input.version,input.retry === true);
      if (task) after(task);
      return automaticBudgetState(id);
    }
    return buildTakeoff(id,input);
  });
}

export function PUT(request: Request, context: Context) {
  return quoteResponse(async ()=>{
    checkDeskOrigin(request);
    return applyTakeoff((await context.params).id, await readJson(request));
  });
}
