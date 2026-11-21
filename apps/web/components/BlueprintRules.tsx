"use client";

import Activity from "@/components/Activity";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "./ui/button";

const choices = [
  ["cut:setup", "Cutting setup time"], ["cut:run", "Cutting run time"],
  ["bend:setup", "Press brake setup time"], ["bend:run", "Press brake run time"],
  ["weld:setup", "Welding setup time"], ["weld:run", "Welding run time"],
  ["filler:consumable", "Weld filler quantity"], ["gas:consumable", "Shielding gas quantity"],
  ["material:stock", "Material allowance"], ["margin", "Target gross margin"],
] as const;
type Rule = {
  id: string; rule_key: string; revision: number; latest_revision: number;
  approved_by: string; rationale: string; citations:{kind:string;reference:string;excerpt:string}[];
  adjustment: {kind:string; category?:string; stage?:string; work_center?:string; factor?:string|number; value?:string|number};
  condition_json: {material_family?:string; processes?:string[]; customer_name?:string; thickness_in?:string|number; customer_tier?:string;
    min_quantity?:number; max_quantity?:number; min_weight_lb?:number; max_weight_lb?:number};
};

function ruleTitle(rule: Rule) {
  const a = rule.adjustment;
  if (a.kind === "set_margin_pct") return "Target gross margin of " + a.value + "%";
  const name = choices.find(([value]) => value === a.category + ":" + a.stage)?.[1] || [a.category,a.stage].filter(Boolean).join(" ");
  if(a.kind==="fill_amount" || a.kind==="fill_rate")return name+" · use "+a.value+" when the "+(a.kind==="fill_rate"?"rate":"amount")+" is zero";
  return (a.work_center ? a.work_center+" · " : "")+name + (a.kind==="multiply_rate"?" rate":"") + " × " + a.factor;
}

function appliesTo(c: Rule["condition_json"]) {
  const limits = [c.min_quantity && "at least " + c.min_quantity + " pieces", c.max_quantity && "up to " + c.max_quantity + " pieces",
    c.min_weight_lb && "at least " + c.min_weight_lb + " lb per piece", c.max_weight_lb && "up to " + c.max_weight_lb + " lb per piece"];
  return [c.material_family,c.thickness_in && c.thickness_in+" in",...(c.processes || []), c.customer_name,c.customer_tier, ...limits].filter(Boolean).join(" · ") || "All blueprint estimates";
}

async function requestRules(body?: unknown,suggestions=false) {
  const response = await fetch("/api/settings/nick-rules"+(suggestions?"?suggestions=1":""), {
    method: body === undefined ? "GET" : "POST", cache:"no-store", headers:{"Content-Type":"application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not save the rule.");
  return result;
}

export function BlueprintRules() {
  const [rules,setRules] = useState<Rule[] | null>(null);
  const [busy,setBusy] = useState(false);
  const [pending,setPending] = useState<Rule[]>([]);
  const [notice,setNotice] = useState("");
  const [selection,setSelection] = useState<string>(choices[0][0]);
  const [retiring,setRetiring] = useState<string|null>(null);
  const key = useRef<string|null>(null);

  async function work(action?: () => Promise<void>, success = "") {
    setBusy(true); setNotice("");
    try {
      if (action) await action();
      const [active,suggestions]=await Promise.all([requestRules(),requestRules(undefined,true)]);
      setRules(active);setPending(suggestions);
      setNotice(success);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to open the rules."); }
    finally { setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const get = (name:string) => String(fields.get(name) || "").trim();
    const [category,stage] = selection.split(":");
    const adjustment = category === "margin" ? {kind:"set_margin_pct",value:get("amount")} :
      {kind:"multiply_amount",category,stage,factor:get("amount")};
    key.current ??= crypto.randomUUID();
    const entry = {rule_key:key.current, expected_revision:0, rule_category:category,
      adjustment, status:"approved", approved_by:get("reviewer"), rationale:get("reason"),
      condition_json:{...(get("material") && {material_family:get("material")}),
        ...(get("process") && {processes:[get("process")]}), ...(get("customer") && {customer_name:get("customer")})}};
    void work(async () => {
      await requestRules({entry}); key.current = null; form.reset(); setSelection(choices[0][0]);
    }, "Rule approved for new blueprint estimates.");
  }

  function retire(event: FormEvent<HTMLFormElement>, rule:Rule) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void work(async () => {
      await requestRules({key:rule.rule_key,entry:{expected_revision:rule.latest_revision, retired_by:fields.get("reviewer"), reason:fields.get("reason")}});
      setRetiring(null);
    }, "Rule retired. Earlier estimates keep their original inputs.");
  }

  return <details className="panel blueprint-rules est-pad" onToggle={e=>{
    if (e.currentTarget.open && rules === null && !busy) void work();
  }}>
    <summary><strong>Nick’s Rules · Blueprint estimating rules</strong></summary>
    <p>Set the allowances and gross margins Nick uses for new blueprint estimates.</p>
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status"><Activity>Updating rules</Activity></p>}
    {rules === null ? !busy && <Button variant="outline" onClick={()=>void work()}>Load rules</Button> :
      <div className="est-stack">
        <section aria-label="Suggested rules"><h3>Suggested changes</h3>
          <p>Three or more comparable finalized quotes can suggest a change. Nick approves it for future estimates.</p>
          {!pending.length && <p>No suggestions awaiting a decision.</p>}
          {pending.map(rule=><article className="est-card" key={rule.id}>
            <h4>{ruleTitle(rule)}</h4><p>{appliesTo(rule.condition_json)}</p><p>{rule.rationale}</p>
            <details><summary>Supporting jobs ({rule.citations.length})</summary><ul>{rule.citations.map(c=><li key={c.reference}>{c.excerpt}</li>)}</ul></details>
            <div className="review-actions">{(["approve","dismiss"] as const).map(action=><Button key={action} disabled={busy} variant={action==="approve"?"default":"outline"} onClick={()=>void work(async()=>{
              await requestRules({key:rule.rule_key,action:"decide",entry:{expected_revision:rule.revision,reviewer:"Nick",action}});
            },action==="approve"?"Rule approved for future estimates.":"Suggestion dismissed.")}>{action==="approve"?"Approve suggestion":"Dismiss suggestion"}</Button>)}</div>
          </article>)}</section>
        <section aria-label="Active rules"><h3>Active rules</h3>
          {rules.length === 0 && <p>No rules approved yet.</p>}
          {rules.map(rule=><article key={rule.id} className="est-card">
            <div className="est-card-head"><strong>{ruleTitle(rule)}</strong>
              <Button variant="outline" disabled={busy} onClick={()=>setRetiring(retiring===rule.id ? null : rule.id)}>
                {retiring===rule.id ? "Cancel" : "Retire rule"}</Button></div>
            <p>{appliesTo(rule.condition_json)}</p>
            <p>{rule.rationale} · Approved by {rule.approved_by}</p>
            {retiring===rule.id && <form onSubmit={e=>retire(e,rule)}><fieldset disabled={busy}><div className="engineering-rate-fields">
              <label className="field">Retired by<input name="reviewer" required maxLength={180}/></label>
              <label className="field">Reason for retiring<input name="reason" required maxLength={500}/></label>
            </div><Button type="submit">Save retirement</Button></fieldset></form>}
          </article>)}
        </section>
        <form onSubmit={save}><fieldset disabled={busy}><legend><strong>Add a rule</strong></legend>
          <div className="engineering-rate-fields">
            <label className="field">What changes<select value={selection} onChange={e=>setSelection(e.target.value)}>
              {choices.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            {selection==="margin" ? <label className="field">Target gross margin (%)<input key="margin" type="number" name="amount" step=".01" min="0" max="99.99" required/></label> :
              <label className="field">Allowance multiplier<input key="factor" name="amount" type="number" step=".001" min=".001" max="10" required placeholder="1.2 for 20% more"/></label>}
          </div>
          <details><summary>Limit to a material, process or customer</summary>
            <div className="engineering-rate-fields">
              <label className="field">Material family<input name="material" placeholder="Any material" maxLength={120}/></label>
              <label className="field">Process<select aria-label="Process" name="process" defaultValue=""><option value="">Any process</option>
                {[["CUT","Cutting"],["BEND","Bending"],["GMAW","MIG"],["GTAW","TIG"],["FCAW","Flux core"],["SMAW","Stick"]].map(([value,label])=>
                  <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field">Customer name<input name="customer" placeholder="Any customer" maxLength={500}/></label>
            </div></details>
          <div className="engineering-rate-fields">
            <label className="field">Reason for this rule<input name="reason" required maxLength={500} placeholder="Why the shop uses this allowance"/></label>
            <label className="field">Approved by<input name="reviewer" required maxLength={180} autoComplete="name"/></label>
          </div>
          <Button type="submit">Approve rule</Button>
        </fieldset></form>
      </div>}
  </details>;
}
