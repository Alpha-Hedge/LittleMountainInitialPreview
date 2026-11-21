"use client";
import Activity from "@/components/Activity";
import { useState, type FormEvent } from "react";
import type { CatalogKind, EngineeringCatalog as Catalog } from "@/lib/engineering-catalog";
import { Button } from "./ui/button";

type Input = [string,string, "text"|"date"|"number", string?];
const common:Input[] = [["effective_on","Effective date","date"],["includes","What the rate covers","text"]];
const center:Input[] = [["name","Work center","text"],["hourly_rate","Shop cost ($/hour)","number","0.0001"],
  ["default_setup_minutes","Setup per batch (min)","number","0.001"],["efficiency_factor","Efficiency factor (1 = standard)","number","0.0001"]];
const material:Input[] = [["spec_code","Material or grade code","text"],["category","Stock form","text"],["supplier","Supplier","text"],
  ["density_lb_per_in3","Density (lb/in³)","number","0.00000001"],["cost_per_lb","Purchase price ($/lb)","number","0.0001"],
  ["default_scrap_pct","Scrap allowance (%)","number","0.0001"],["k_factor","Bend K-factor, if known","number","0.00001"]];

export function EngineeringCatalog() {
  const [catalog,setCatalog] = useState<Catalog|null>(null);
  const [kind,setKind] = useState<CatalogKind>("work-centers");
  const [message,setMessage] = useState(""), [busy,setBusy] = useState(false);
  async function load() {
    setBusy(true); setMessage("");
    try {
      const res=await fetch("/api/settings/catalog",{cache:"no-store"}); const data=await res.json();
      if (!res.ok) throw Error(data.error); setCatalog(data);
    } catch(err){ setMessage(err instanceof Error ? err.message : "Could not open the catalog."); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=event.currentTarget; setBusy(true); setMessage("");
    const entry:Record<string,unknown> = Object.fromEntries(new FormData(form));
    if(kind==="work-centers") entry.unit="USD/hour";
    else if(!entry.k_factor) entry.k_factor=null;
    try {
      const res=await fetch("/api/settings/catalog",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({kind,entry})});
      const data=await res.json(); if(!res.ok) throw Error(data.error);
      setCatalog(data); form.reset(); setMessage(
        String(entry.effective_on) > data.as_of
          ? "Rate scheduled for " + entry.effective_on + "."
          : "Dated rate saved."
      );
    } catch(err){ setMessage(err instanceof Error ? err.message : "Could not save this rate."); }
    finally {setBusy(false);}
  }
  const headings = kind === "materials"
    ? ["Material and supplier", "Purchase price", "Density", "Stock form", "Scrap", "K-factor", "Effective", "Includes"]
    : ["Work center", "Shop cost", "Setup per batch", "Efficiency factor", "Effective", "Includes"];
  const rows=catalog ? kind==="materials" ? catalog.materials.map(m=>[m.spec_code+" · "+m.supplier,"$"+m.cost_per_lb+"/lb",
      m.density_lb_per_in3+" lb/in³",m.category,m.default_scrap_pct+"%",m.k_factor ?? "Unspecified",m.effective_on,m.includes])
    :catalog.work_centers.map(w=>[w.name,"$"+w.hourly_rate+"/hour",w.default_setup_minutes+" min",w.efficiency_factor,w.effective_on,w.includes]) : [];
  return <details className="panel engineering-catalog" onToggle={e=>{if(e.currentTarget.open && !catalog && !busy) void load();}}>
    <summary>Engineering rate catalog</summary>
    <p>Record dated supplier prices and work-center rates for sheet-stock routing.</p>
    {message && <p role="status">{message}</p>}
    {busy && <p role="status"><Activity>Updating shop settings</Activity></p>}
    {catalog ? <>
      <label className="field">Catalog<select value={kind} disabled={busy} onChange={e=>{setKind(e.target.value as CatalogKind);setMessage("");}}>
        <option value="work-centers">Work centers</option><option value="materials">Supplier materials</option></select></label>
      <table><caption>Rates in effect on {catalog.as_of}</caption><thead><tr>{headings.map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(row=><tr key={row[0]}>{row.map((value,i)=><td key={i}>{value}</td>)}</tr>)}</tbody></table>
      {!rows.length && <p>No current rates in this catalog.</p>}
      <form key={kind} onSubmit={save}><h3>Add a dated rate</h3><div className="engineering-rate-fields">
        {[...(kind==="materials"?material:center),...common].map(([key,label,type,step])=><label className="field" key={key}>{label}
          <input name={key} type={type} step={step} min={key==="density_lb_per_in3" || key==="efficiency_factor" ? step : type==="number"?0:undefined}
            max={key==="k_factor" ? 1 : undefined} required={key!=="k_factor"}
            defaultValue={key==="effective_on"?catalog.as_of:key==="efficiency_factor"?"1":undefined}/></label>)}</div>
        <Button type="submit" disabled={busy}>Save rate</Button></form>
    </> : !busy && <Button onClick={()=>void load()} variant="outline">Open catalog</Button>}
  </details>;
}
