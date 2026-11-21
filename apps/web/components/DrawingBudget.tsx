"use client";

import { useRef, useState } from "react";
import type { Quote } from "@/lib/types";
import type { TakeoffPreview, TakeoffScope } from "@/lib/takeoff-types";
import Activity from "./Activity";
import { formatUSD } from "./EstimatingFields";

export default function DrawingBudget({quote,disabled,contingencyDefault,onApply}:{
  quote: Quote; disabled: boolean; contingencyDefault: number; onApply: (quote: Quote)=>void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const running = useRef(false);
  const previous = quote.benchmark?.takeoff;
  const [scope,setScope] = useState<TakeoffScope>(previous?.scope ?? "shop");
  const [contingency,setContingency] = useState(previous?.contingencyPercent ?? contingencyDefault);
  const [preview,setPreview] = useState<TakeoffPreview|null>(null);
  const [busy,setBusy] = useState<"build"|"apply"|null>(null);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  const changed = preview && (preview.scope !== scope || preview.contingencyPercent !== contingency);
  async function request(apply: boolean) {
    if (running.current || (apply && (!preview || changed))) return;
    setBusy(apply?"apply":"build");
    setError("");
    running.current = true;
    if (!apply) setPreview(null);
    try {
      const response = await fetch("/api/quotes/"+quote.id+"/takeoff",{
        method:apply?"PUT":"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify(apply?{version:quote.version,planId:preview?.id}:{version:quote.version,scope,contingencyPercent:contingency}),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Could not prepare the budget.");
      if (apply) {
        onApply(result as Quote);
        setPreview(null);
        setNotice("Drawing budget saved as a new quote version.");
        dialog.current?.close();
      } else setPreview(result as TakeoffPreview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not prepare the budget. Try again.");
    } finally {
      running.current = false;
      setBusy(null);
    }
  }
  return <div className="qe-benchmark">
    <button type="button" className="button primary" disabled={disabled} onClick={()=>{setNotice("");dialog.current?.showModal();}}>
      Build drawing budget
    </button>
    <p>{disabled ? "Save the quote first." : "Estimate stock and shop work from the drawing. Add site work if it’s part of the bid."}</p>
    {notice && <p role="status">{notice}</p>}
    <dialog ref={dialog} className="qe-takeoff" aria-labelledby="takeoff-title" onCancel={event=>{if(busy)event.preventDefault();}}>
      <header><div><h2 id="takeoff-title">Drawing budget</h2><p>{quote.jobName}</p></div>
        <button type="button" className="button secondary" disabled={!!busy} onClick={()=>dialog.current?.close()}>Close</button>
      </header>
      <form className="qe-takeoff-options" onSubmit={event=>{event.preventDefault();void request(false);}}>
        <label>Scope<select value={scope} disabled={!!busy} onChange={event=>setScope(event.target.value as TakeoffScope)}>
          <option value="shop">Shop fabrication only</option><option value="installed">Fabrication, delivery and installation</option>
        </select></label>
        <label>Contingency (%)<input type="number" min="0" max="100" step="0.0001" required disabled={!!busy}
          value={Number.isFinite(contingency)?contingency:""} onChange={event=>setContingency(event.target.valueAsNumber)}/></label>
        <button type="submit" className="button primary" disabled={!!busy}>{busy==="build"?<Activity>Reading and pricing</Activity>:"Calculate budget"}</button>
      </form>
      {busy==="build" && <p role="status">Reading the plan and details, estimating quantities, then pricing them with the active rate book.</p>}
      {error && <p role="alert" className="error-banner">{error}</p>}
      {preview && <section className="qe-takeoff-result" aria-label="Proposed drawing budget">
        {changed && <p role="status">Calculate again to use the updated scope or contingency.</p>}
        <dl className="qe-takeoff-totals">
          <div><dt>Direct cost</dt><dd>{formatUSD(preview.directCost)}</dd></div>
          <div><dt>Contingency</dt><dd>{formatUSD(preview.contingencyCost)}</dd></div>
          <div><dt>Budget before tax</dt><dd>{formatUSD(preview.sellingPrice)}</dd></div>
          {preview.shopOnlySellingPrice !== undefined && <div><dt>Shop-only option</dt><dd>{formatUSD(preview.shopOnlySellingPrice)}</dd></div>}
        </dl>
        {preview.scopeSummary && <p>{preview.scopeSummary}</p>}
        <p>Amounts cover the whole proposed job. Check the assumptions and compare the source before using the budget.</p>
        {[...new Set(preview.rows.map(row=>row.group))].map(group=>{
          const rows = preview.rows.filter(row=>row.group===group);
          return <details key={group}><summary>{group} · {formatUSD(rows.reduce((sum,row)=>sum+row.cost,0))}</summary>
            <ul>{rows.map((row,i)=><li key={i}><strong>{row.label} · {formatUSD(row.cost)}</strong>
              <p>{row.amount} {row.unit} × {formatUSD(row.rate)}{row.minimumCost > 0 && " · "+formatUSD(row.minimumCost)+" minimum"}</p>
              <small>{row.evidence && row.evidence+" quantity · "}Rate {row.rateId}</small><br/>
              <small>{row.basis} {row.assumption}</small></li>)}</ul>
          </details>;
        })}
        {!!preview.checks.length && <details><summary>Confirm before sending ({preview.checks.length})</summary>
          <ul>{preview.checks.map(check=><li key={check}>{check}</li>)}</ul>
        </details>}
        <p>Saving replaces the quick automatic allowances on eligible parts. Staff-entered costs are kept.</p>
        <button type="button" className="button primary" disabled={!!busy || !!changed}
          onClick={()=>void request(true)}>{busy==="apply"?<Activity>Saving budget</Activity>:"Save budget to quote"}</button>
      </section>}
    </dialog>
  </div>;
}
