"use client";

import Activity from "@/components/Activity";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Field, formatUSD } from "./EstimatingFields";
import type { EngineeringCatalog } from "@/lib/engineering-catalog";
import { routingUnits as units, type RoutingStock as Stock, type RoutingOperation as Operation, type RoutingResult as Routing } from "@/lib/routing-types";

const stockFields = [
  ["width", "Stock width (mm)"], ["height", "Stock length (mm)"],
  ["blankWidth", "Blank width (mm)"], ["blankHeight", "Blank length (mm)"],
  ["margin", "Edge margin on all sides (mm)"], ["gap", "Clear gap between blanks (mm)"],
  ["sheetCost", "Purchase cost per sheet ($)"],
] as const;
const blankStock: Stock = { width: NaN, height: NaN, blankWidth: NaN, blankHeight: NaN, margin: NaN, gap: NaN, sheetCost: NaN, allowRotation: false };
const makeOperation = (): Operation => ({ name: "", unit: "mm cut", unitsPerPiece: NaN, unitsPerHour: NaN, setupMinutes: NaN, hourlyRate: NaN });
const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

function InputNumber({ label, value, positive, onChange }: { label: string; value: number; positive?: boolean; onChange: (n: number) => void }) {
  return <Field label={label}><input type="number" step="0.0001" inputMode="decimal" min={positive ? "0.0001" : "0"}
    required value={Number.isFinite(value) ? value : ""} onChange={e => onChange(e.target.valueAsNumber)} /></Field>;
}

interface Props {
  quoteId: string; quoteVersion: number; itemId: string; quantity: number; description: string; templateDirty: boolean;
  onSaved: () => void;
}

function RoutingDialog({ quoteId, quoteVersion, itemId, quantity, description, templateDirty, onSaved, dismiss }: Props & { dismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [stock, setStock] = useState<Stock>(blankStock);
  const [catalog, setCatalog] = useState<EngineeringCatalog | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [result, setResult] = useState<Routing | null>(null);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const loadingFailed = useRef(false);
  const pending = useRef(false);
  const endpoint = "/api/quotes/" + encodeURIComponent(quoteId) + "/routing";
  useEffect(() => {
    const controller = new AbortController();
    const node = dialog.current;
    node?.showModal();
    void fetch("/api/settings/catalog", { signal: controller.signal }).then(async r => {
      if (r.ok && !controller.signal.aborted) setCatalog(await r.json());
    }).catch(() => {});
    void (async () => {
      try {
        const res = await fetch(endpoint + "?" + new URLSearchParams({ itemId }), { cache: "no-store", signal: controller.signal });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Could not load saved routing inputs.");
        if (body.saved && !controller.signal.aborted) {
          setStock(body.saved.stock); setOperations(body.saved.operations); setSavedVersion(body.saved.quoteVersion);
        }
      } catch (problem) {
        if (!controller.signal.aborted) {
          loadingFailed.current = true;
          setError(problem instanceof Error ? problem.message : "Could not open the routing.");
        }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); node?.close(); };
  }, [endpoint, itemId]);

  function changed() { setResult(null); setConfirmed(false); setError(""); }
  function setOperation(index: number, patch: Partial<Operation>) {
    changed();
    setOperations(old => old.map((op, i) => i === index ? { ...op, ...patch } : op));
  }
  async function calculate(action: "preview" | "apply") {
    if (pending.current || loadingFailed.current || loading) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, itemId, quoteVersion, stock, operations }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not calculate this routing.");
      if (action === "apply") onSaved(); else {
        setResult(body);
        if (stock.materialId) setStock(prev => ({...prev,sheetCost:body.sheetCost}));
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Routing request failed."); }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="routing-dialog" aria-labelledby="routing-title"
    onCancel={event => { event.preventDefault(); if (!busy) dismiss(); }}>
    <header className="routing-heading"><div><h2 id="routing-title">Sheet stock and work centers</h2>
      <p>{description.split("\n")[0]} · {quantity} {quantity === 1 ? "piece" : "pieces"}</p></div>
      <Button variant="outline" type="button" onClick={dismiss} disabled={busy}>Close</Button>
    </header>
    {loading && <p role="status"><Activity>Loading saved inputs</Activity></p>}
    {error && <p role="alert" className="routing-error">{error}</p>}
    {!loading && !loadingFailed.current && <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void calculate("preview"); }}>
      <fieldset disabled={busy} className="routing-fields">
        <section><h3>Stock and rectangular blank</h3><p>Enter the purchased sheet size and the blank needed for one piece. The estimate charges for whole sheets.</p>
          {savedVersion !== null && <p>Loaded the routing saved with quote version {savedVersion}.</p>}
          {(stock.materialId || !!catalog?.materials.length) && <Field label="Sheet price source"><select value={stock.materialId ?? ""}
            onChange={e=>{changed();setStock(prev=>({...prev,materialId:e.target.value || undefined}));}}>
            <option value="">Enter supplier price per sheet</option>
            {stock.materialId && !catalog?.materials.some(m=>m.id===stock.materialId) && <option value={stock.materialId}>Saved supplier revision</option>}
            {catalog?.materials.map(m=><option key={m.id} value={m.id}>{m.spec_code} · {m.supplier} · {formatUSD(Number(m.cost_per_lb))}/lb</option>)}</select></Field>}
          <div className="routing-grid">{stock.materialId && <InputNumber label="Stock thickness (mm)" value={stock.thicknessMm ?? NaN} positive onChange={v=>{changed();setStock({...stock,thicknessMm:v});}}/>}
          {stockFields.filter(([key])=>key!=="sheetCost" || !stock.materialId).map(([key, label]) => <InputNumber key={key} label={label} value={stock[key]}
            positive={["width","height","blankWidth","blankHeight"].includes(key)}
            onChange={value => { changed(); setStock({ ...stock, [key]: value }); }} />)}</div>
          <label className="routing-check"><input type="checkbox" checked={stock.allowRotation}
            onChange={e => { changed(); setStock({ ...stock, allowRotation: e.target.checked }); }} />Allow 90° blank rotation</label>
        </section>
        <section><h3>Work centers</h3><p>Use measured throughput and the shop’s hourly cost for each operation. Setup applies once to the batch.</p>
          {operations.map((op, index) => <fieldset className="routing-operation" key={index}>
            <legend>Operation {index + 1}</legend>
            <div className="routing-grid">
              {(op.centerId || !!catalog?.work_centers.length) && <Field label="Work-center rate source"><select value={op.centerId ?? ""} onChange={e=>{
                const c=catalog?.work_centers.find(rate=>rate.id===e.target.value);
                setOperation(index,c ? {centerId:c.id,name:c.name,hourlyRate:Number(c.hourly_rate),setupMinutes:Number(c.default_setup_minutes)} : {centerId:undefined});
              }}><option value="">Enter shop rate</option>
                {op.centerId && !catalog?.work_centers.some(c=>c.id===op.centerId) && <option value={op.centerId}>Saved work-center revision</option>}
                {catalog?.work_centers.map(c=><option key={c.id} value={c.id}>{c.name} · {formatUSD(Number(c.hourly_rate))}/h</option>)}</select></Field>}
              <Field label="Work center or operation"><input required maxLength={100} value={op.name} onChange={e => setOperation(index, {name:e.target.value})} /></Field>
              <Field label="Production unit"><select value={op.unit} onChange={e => setOperation(index, {unit:e.target.value as Operation["unit"]})}>
                {units.map(unit => <option key={unit} value={unit}>{unit}</option>)}</select></Field>
              <InputNumber label={"Units per piece (" + op.unit + ")"} value={op.unitsPerPiece} onChange={v => setOperation(index,{unitsPerPiece:v})}/>
              <InputNumber label={(op.centerId ? "Throughput at 100% efficiency (" : "Throughput (") + op.unit + " per hour)"} value={op.unitsPerHour} positive onChange={v => setOperation(index,{unitsPerHour:v})}/>
              <InputNumber label="Setup per batch (minutes)" value={op.setupMinutes} onChange={v => setOperation(index,{setupMinutes:v})}/>
              <InputNumber label="Work-center cost ($/hour)" value={op.hourlyRate} onChange={v => setOperation(index,{hourlyRate:v})}/>
            </div>
            {op.centerId && (() => {
              const center = catalog?.work_centers.find(c=>c.id===op.centerId);
              return center && <><p>Run time uses the saved efficiency factor of {Number(center.efficiency_factor)}. Setup applies once.</p>
                {(Number(center.hourly_rate)!==op.hourlyRate || Number(center.default_setup_minutes)!==op.setupMinutes) &&
                  <Field label="Reason for changing setup or hourly cost"><input required maxLength={1000} value={op.overrideReason ?? ""} onChange={e=>setOperation(index,{overrideReason:e.target.value})}/></Field>}</>;
            })()}
            <button type="button" className="routing-remove" onClick={() => { changed();setOperations(current => current.filter((_,i) => i !== index)); }}>Remove operation {index + 1}</button>
          </fieldset>)}
          <Button type="button" variant="outline" onClick={() => { changed();setOperations(prev=>[...prev,makeOperation()]); }}>Add operation</Button>
        </section>
        <Button type="submit">{busy ? <Activity>Calculating</Activity> : "Calculate routing"}</Button>
        {result && <section className="routing-result" aria-label="Calculated routing">
          <h3>Batch estimate</h3>
          <dl>{[
            ["Sheets to purchase", String(result.sheetCount)], ["Capacity per sheet", String(result.piecesPerSheet)],
            ["Material yield", format.format(result.yieldPercent) + "%"], ["Sheet cost", formatUSD(result.materialCost)],
          ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          {result.operationHours.length > 0 && <div className="routing-hours"><table><caption>Hours by work center</caption>
            <thead><tr><th>Operation</th><th>Setup</th><th>Run</th><th>Total</th></tr></thead><tbody>
              {result.operationHours.map((r,i)=><tr key={i}><th scope="row">{r.name}</th><td>{format.format(r.setupHours)}</td><td>{format.format(r.runHours)}</td><td>{format.format(r.totalHours)}</td></tr>)}
            </tbody></table></div>}
          <p className="routing-total">Material and work-center cost <strong>{formatUSD(result.total)}</strong></p>
          {savedVersion !== null && <label className="routing-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />Replace the previously saved routing costs for this item.</label>}
          {templateDirty && <p className="routing-error">Saving this routing will discard your unsaved template edits.</p>}
          <Button type="button" disabled={savedVersion !== null && !confirmed}
            onClick={() => { if (!templateDirty || window.confirm("Discard unsaved template edits and save this routing?")) void calculate("apply"); }}>
            Save routing costs to quote
          </Button>
        </section>}
      </fieldset>
    </form>}
  </dialog>;
}

export function RoutingCalculator(props: Props) {
  const [open,setOpen] = useState(false);
  return <div>
    <Button type="button" variant="outline" onClick={()=>setOpen(true)}>Calculate sheet stock and work-center time</Button>
    {open && createPortal(<RoutingDialog {...props} dismiss={()=>setOpen(false)} />, document.body)}
  </div>;
}
