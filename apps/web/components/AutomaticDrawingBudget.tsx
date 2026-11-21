"use client";

import { useEffect, useRef, useState } from "react";
import type { AutomaticBudgetState } from "@/lib/takeoff-types";
import type { Quote } from "@/lib/types";
import Activity from "./Activity";

export default function AutomaticDrawingBudget({id,version,onSave}:{
  id: string; version: number; onSave: (quote: Quote)=>boolean;
}) {
  const [retry,setRetry] = useState(0);
  const [status,setStatus] = useState<AutomaticBudgetState>({state:"taking_off"});
  const [hasNewVersion,setHasNewVersion] = useState(false);
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(()=>{
    const controller = new AbortController();
    const url = "/api/quotes/"+id+"/takeoff";
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function fetchState(start:boolean) {
      try {
        const response = await fetch(url,start ? {
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({version,automatic:true,retry:retry>0}),signal:controller.signal,
        }:{signal:controller.signal,cache:"no-store"});
        const result = await response.json();
        if (!response.ok) throw Error(result.error || "Could not open the drawing budget.");
        if (controller.signal.aborted) return;
        setStatus(result as AutomaticBudgetState);
        if (result.state === "ready") {
          const current = await fetch("/api/quotes/"+id,{signal:controller.signal,cache:"no-store"});
          if (!current.ok) throw Error("The budget was saved. Reopen the quote to see it.");
          const quote = await current.json() as Quote;
          if (!controller.signal.aborted) setHasNewVersion(!save.current(quote));
        } else if (result.state === "idle") {
          setStatus({state:"failed",error:"This quote changed while the takeoff was running. Save or reopen the current quote to rebuild the budget."});
        } else if (result.state !== "failed") timer = setTimeout(()=>void fetchState(false),2200);
      } catch (cause) {
        if (!controller.signal.aborted)
          setStatus({state:"failed",error:cause instanceof Error ? cause.message : "The takeoff could not be loaded."});
      }
    }
    void fetchState(true);
    return ()=>{controller.abort();clearTimeout(timer);};
  },[id,version,retry]);
  return <section className="qe-budget-progress" aria-label="Automatic drawing budget">
    {status.state === "failed" ? <>
      <strong>Full budget needs another pass</strong>
      <p role="alert">{status.error}</p>
      <button type="button" className="button secondary" onClick={()=>{setStatus({state:"taking_off"});setRetry(n=>n+1);}}>Retry full budget</button>
    </> : hasNewVersion ? <>
      <strong>New budget saved</strong>
      <p>Review or copy your unsaved edits before reopening the latest version.</p>
      <a href={"/quotes/"+id}>Open saved budget</a>
    </> : <div role="status">
      <strong><Activity>{status.state==="checking" ? "Checking quantities and scope" : status.state==="ready" ? "Opening the saved budget" : "Building full drawing budget"}</Activity></strong>
      <p>Estimating stock, shop work and any in-scope installation. The draft will update here when pricing is ready.</p>
    </div>}
  </section>;
}
