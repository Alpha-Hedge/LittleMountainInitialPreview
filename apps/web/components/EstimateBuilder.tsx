"use client";
import Activity from "@/components/Activity";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EstimatingSettings } from "@/lib/estimating-types";
import type { HistoryAwareSuggestion } from "@/lib/history-types";
import { fieldLabels, type FieldKey } from "@/lib/review-types";
import type { CostRow, Quote, QuoteTotals, RowEstimate } from "@/lib/types";
import { BasisField, DecimalField, Field, formatUSD, formatRate } from "./EstimatingFields";
import { Icon } from "./Icons";
import { WorkAmountField, usesHours } from "./WorkAmountField";
import { RoutingCalculator } from "./RoutingCalculator";

interface Props {
  quote: Quote;
  settings: EstimatingSettings;
  initialItem: string;
  initialTemplate: string;
  initialSuggestion: HistoryAwareSuggestion;
}

export default function EstimateBuilder({quote, settings, initialItem, initialTemplate, initialSuggestion}: Props) {
  const [itemId, setItem] = useState(initialItem);
  const [templateId, setTemplate] = useState(initialTemplate);
  const [suggestion, setSuggestion] = useState<HistoryAwareSuggestion | null>(initialSuggestion);
  const [rows, setRows] = useState(initialSuggestion.rows);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [keepManual, setKeepManual] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pricingError, setPricingError] = useState("");
  const [totals, setTotals] = useState<QuoteTotals | null>(null);
  const item = quote.items.find(i => i.id === itemId)!;
  const path = "/quotes/" + encodeURIComponent(quote.id);
  const endpoint = "/api" + path + "/estimate";
  const selected = useMemo(() => rows.filter(r => !excluded.includes(r.id)), [rows, excluded]);
  const changed = !!suggestion && (JSON.stringify(rows)!==JSON.stringify(suggestion.rows) || excluded.length>0 || !keepManual);
  const leavingAfterSave=useRef(false);
  useEffect(()=>{
    if(!changed)return;
    function protect(event:BeforeUnloadEvent){if(!leavingAfterSave.current)event.preventDefault();}
    window.addEventListener("beforeunload",protect);
    return ()=>window.removeEventListener("beforeunload",protect);
  },[changed]);
  useEffect(() => {
    setTotals(null);
    setPricingError("");
    if (!suggestion || !selected.length) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const items = quote.items.map(i => i.id === itemId ? { ...i, costRows: [...i.costRows.filter(r => keepManual && !r.estimate), ...selected] } : i);
      try {
        const response = await fetch("/api/quotes/calculate", {method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({...quote,items}), signal:controller.signal});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (!controller.signal.aborted) setTotals(data);
      } catch (err) { if (!controller.signal.aborted) setPricingError(err instanceof Error ? err.message : "Pricing unavailable."); }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [quote,itemId,suggestion,keepManual,selected]);

  async function preview(nextItem: string, nextTemplate: string) {
    if(changed && !window.confirm("Switch work and discard the cost changes you have not saved?"))return;
    setKeepManual(true);
    setItem(nextItem); setTemplate(nextTemplate); setBusy(true); setError(""); setSuggestion(null); setRows([]); setExcluded([]);
    try {
      const response = await fetch(endpoint, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"suggest",itemId:nextItem,templateId:nextTemplate})});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.quoteVersion !== quote.version) throw new Error("The quote changed. Reopen the estimate builder.");
      setSuggestion(data); setRows(data.rows);
    } catch (err) { setError(err instanceof Error ? err.message : "Template preview unavailable."); }
    finally { setBusy(false); }
  }
  function updateRow(id: string, patch: Partial<CostRow>) {
    setRows(current => current.map(row => row.id === id ? {...row,...patch} : row));
  }
  function updateBasis(row: CostRow, patch: Partial<RowEstimate>) {
    updateRow(row.id, {estimate:{...row.estimate!, ...patch}});
  }
  async function apply() {
    if (!suggestion) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, {method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ action:"apply", itemId, templateId, rows:selected, keepManual, settingsVersion:suggestion.settingsVersion,
          quoteVersion:suggestion.quoteVersion,selectedRevisionId:suggestion.selectedRevisionId,pricingDate:suggestion.pricingDate })});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      leavingAfterSave.current=true;
      window.location.assign(path + "/estimate?justSaved=1&version=" + data.version);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not apply the estimate."); setBusy(false); }
  }
  const compareUrl=path+"/history?"+new URLSearchParams({itemId,templateId});
  const currentType=settings.templates.find(t=>t.id===templateId);
  const manualRows=item.costRows.filter(r=>!r.estimate).length;
  const memory=suggestion?.comparison;
  const unpricedOtherItems = quote.items.filter(other => other.id !== itemId && other.costRows.length === 0).length;
  const templateHasMaterial = rows.some(row => row.estimate?.category === "material" && !excluded.includes(row.id));

  return <form onSubmit={e=>{e.preventDefault();void apply();}}>
    <fieldset disabled={busy} className="est-layout est-build">
      <div className="est-stack">
        <section className="panel">
          <div className="panel-heading"><h2>Choose the work</h2></div>
          <div className="est-pad est-stack">
            <div className="est-grid">
              <Field label="Which part or service?"><select value={itemId} onChange={e=>void preview(e.target.value,templateId)}>
                {quote.items.map(i=><option key={i.id} value={i.id}>{i.description.split("\n")[0]} · {i.quantity} ordered{quote.items.length > 1 ? (i.costRows.length ? " · Costs saved" : " · Needs costs") : ""}</option>)}
              </select></Field>
              <Field label="Job type"><select value={templateId} onChange={e=>void preview(itemId,e.target.value)}>
                {settings.templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
              </select></Field>
            </div>
            <p className="est-muted">The job type starts with the usual work and materials. Check what applies to this part.</p>
            <RoutingCalculator key={itemId} quoteId={quote.id} quoteVersion={quote.version} itemId={itemId}
              quantity={item.quantity} description={item.description} templateDirty={changed}
              onSaved={() => { leavingAfterSave.current = true; window.location.assign(path); }} />
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><h2>Check the work and materials</h2></div>
          <div className="est-pad est-stack">
            {rows.map(row=>{
              const details=row.estimate!,included=!excluded.includes(row.id);
              const original=suggestion!.rows.find(r=>r.id===row.id)!;
              const baseline=original.estimate!;
              const amountNeedsCheck = suggestion!.missingOperationIds.includes(details.operationId);
              const reasonRequired=amountNeedsCheck||row.amount!==original.amount||
                row.rate!==original.rate||row.basis!==original.basis||details.minimumCost!==baseline.minimumCost||
                details.unit!==baseline.unit||details.includes!==baseline.includes;
              const cost=totals?.items.find(i=>i.id===itemId)?.rows.find(r=>r.id===row.id)?.cost;
              const rateLabel = details.category === "material" ? "Material cost per " + details.unit + " ($)"
                : (usesHours(details.unit) ? "Shop cost per hour ($)" : "Shop cost per " + details.unit + " ($)");
              return <article key={row.id} className={"est-work-card"+(included?"":" est-skipped")+(included&&amountNeedsCheck?" est-needs-amount":"")}>
                <header><label className="est-check"><input type="checkbox" checked={included} onChange={()=>
                  setExcluded(prev=>included?[...prev,row.id]:prev.filter(id=>id!==row.id))}/><strong>{row.label||original.label}</strong></label>
                  {included&&<b>{cost===undefined?"…":formatUSD(cost)}</b>}</header>
                {included&&<div className="est-work-content">
                  {amountNeedsCheck && <p className="est-amount-hint">{details.rationale.split(". ")[0]}.</p>}
                  <div className="est-grid est-allowance">
                    <WorkAmountField unit={details.unit} basis={row.basis} value={row.amount} onChange={amount=>updateRow(row.id,{amount})}/>
                    <DecimalField label={rateLabel} value={row.rate} onChange={rate=>updateRow(row.id,{rate})}/>
                  </div>
                  {details.rateSource && <p className="est-rate-source">Rate from {details.rateSource}{details.rateEffectiveOn && " · " + details.rateEffectiveOn}</p>}
                  {reasonRequired&&<Field label="Why are you changing this?"><input required value={details.overrideReason} placeholder="For example, this job needs a second setup"
                    onChange={event=>updateBasis(row,{overrideReason:event.target.value})}/></Field>}
                  <details className="est-disclose" onInvalidCapture={event => { event.currentTarget.open = true; }}><summary>How this cost was picked</summary>
                    <div className="est-detail-content"><p>{details.rationale}</p>
                    <div className="est-grid"><Field label="Name of this cost"><input required value={row.label} onChange={v=>updateRow(row.id,{label:v.target.value})}/></Field>
                    <Field label="Unit (such as hour or piece)"><input required value={details.unit} onChange={v=>updateBasis(row,{unit:v.target.value})}/></Field>
                    <BasisField value={row.basis} onChange={basis=>updateRow(row.id,{basis})}/>
                    <DecimalField label="Minimum charge ($)" value={details.minimumCost} onChange={minimumCost=>updateBasis(row,{minimumCost})}/>
                    <Field label="What the rate covers" wide><input required value={details.includes} onChange={v=>updateBasis(row,{includes:v.target.value})}/></Field>
                    <Field label="What are we assuming?" wide><textarea value={details.assumption} onChange={v=>updateBasis(row,{assumption:v.target.value})}/></Field>
                    {!reasonRequired&&<Field label="Reason for a change (optional)" wide><input value={details.overrideReason} onChange={v=>updateBasis(row,{overrideReason:v.target.value})}/></Field>}
                    </div></div>
                  </details>
                </div>}
              </article>;
            })}
            {!suggestion&&<button className="button secondary" type="button" onClick={()=>void preview(itemId,templateId)}>{busy?<Activity>Loading prices</Activity>:"Try loading prices again"}</button>}
            {suggestion && !templateHasMaterial && <p className="est-muted">Check that any materials you supply are priced. <a href={path}>Open the quote to add a cost by hand.</a></p>}
          </div>
        </section>
      </div>
      <aside className="est-stack est-bill">
        <section className="panel">
          <div className="panel-heading"><h2>Price for the whole quote</h2></div>
          <div className="est-pad est-stack"><div className="est-sale"><small>{unpricedOtherItems ? "Price so far before tax" : "Customer price before tax"}</small><strong>{totals?formatUSD(totals.sellingPrice):"—"}</strong></div>
            <div className="est-cost-line"><span>Cost to the shop</span><b>{totals?formatUSD(totals.estimatedCost):"—"}</b></div>
            <p className="est-muted">Includes {quote.marginPercent}% gross margin. <a href={path + "#quote-price"}>Change margin on quote</a></p>
            {manualRows>0&&<label className="est-check"><input type="checkbox" checked={keepManual} onChange={e=>setKeepManual(e.target.checked)}/>
              Keep the costs already entered by hand ({manualRows})</label>}
            {item.costRows.some(r=>r.estimate)&&<p className="est-muted">Saving replaces the suggested costs for this part.</p>}
            {(error||pricingError)&&<p role="alert" className="field-error">{error||pricingError}</p>}
            {!selected.length&&suggestion&&<p role="status">Check at least one cost to save this price.</p>}
            <button type="submit" className="button primary" disabled={!totals||!selected.length||!suggestion}>{busy?<Activity>Updating estimate</Activity>:"Save costs to quote"} <Icon name="arrow" size={17}/></button>
            <p className="est-muted">{unpricedOtherItems ? "Next, price the remaining " + (unpricedOtherItems === 1 ? "item." : unpricedOtherItems + " items.") : "Next, review the customer quote."}</p>
          </div>
        </section>
        <details className="panel est-disclose est-panel-details"><summary>Drawing details for this part</summary><div className="est-pad">
          {suggestion?.reviewRunId?<dl className="est-specs">{Object.entries(suggestion.fields).map(([key,value])=><div key={key}><dt>{fieldLabels[key as FieldKey]}</dt><dd>{value}</dd></div>)}</dl>:
            <p>No drawing details have been confirmed for this part.</p>}
          {suggestion?.selectedRevisionId&&<a href={path+"/review/"+suggestion.selectedRevisionId}>Check the drawing</a>}
        </div></details>
      </aside>
      <details className="panel est-disclose est-panel-details est-comparables" open={memory?.count ? true : undefined}>
        <summary>Past jobs like this</summary>
        <div className="est-pad est-stack">{suggestion?.comparisonError?<p role="alert">Past jobs could not be loaded. You can still price this work using the shop rates.</p>:memory&&<>
          {memory.count===0?<p>No similar approved jobs yet. These allowances come from {currentType?.name}.</p>:
            <><p>{memory.count} similar approved {memory.count===1?"job":"jobs"} found.</p>
              {memory.observations.map(o=><p className="est-history-fact" key={o.operationId}><strong>{o.label}</strong>
              Usual estimate {Number((60*o.templateHours).toFixed(2))} minutes. Typical time on {o.samples.length} finished {o.samples.length===1?"job":"jobs"} was {Number((60*o.observedHours).toFixed(2))} minutes {o.basis==="batch"?"for the whole batch":"per piece"}.
              {o.recurring&&" Nick can review a change to the usual time."}</p>)}
              {memory.preferences.map(p=><p key={p.ref}><b>Nick’s usual pricing</b> · {p.reason} · {p.approvedMarginPercent}% margin</p>)}</>}
          </>}
          <a href={compareUrl}>Check times against past jobs</a>
        </div>
      </details>
    </fieldset>
  </form>;
}
