"use client";
import Activity from "@/components/Activity";
import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {driverLabels, drawingRoles, effectiveRate, hourlyCostLabels, hourlyTotal, rateGroups, stockForms, budgetRoles, type EstimatingProfiles, type HourlyCost, type RateGroup, type RateRevision, type ShopRate, type EstimateTemplate, type TemplateOperation} from "@/lib/estimating-types";
import type {RateCategory, QuantityDriver} from "@/lib/types";
import {BasisField, DecimalField, Field, formatRate} from "./EstimatingFields";
import {WorkAmountField} from "./WorkAmountField";
import {Icon} from "./Icons";

type Section="prices"|"types";
type Editing="price"|"type"|"defaults"|null;
const categories:Record<RateCategory,string>={material:"Material",setup:"Setup",labor:"Shop labor",machine:"Machine time",outside:"Outside service"};

function newStep(rateId:string):TemplateOperation {
  return {id:crypto.randomUUID(),label:"",rateId,amount:1,driver:"fixed",basis:"batch",assumption:""};
}

export default function EstimatingSettingsEditor({initial,history,today,references}:{
  initial:EstimatingProfiles;history:RateRevision[];today:string;references:{name:string;url:string}[];
}){
  const [profiles,setProfiles]=useState(initial);
  const [profile,setProfile]=useState<keyof Omit<EstimatingProfiles,"active">>(initial.active);
  const [group,chooseGroup]=useState("");
  const [search,setSearch]=useState("");
  const router=useRouter();
  const [saved,setSaved]=useState(initial[initial.active]),[settings,setSettings]=useState(initial[initial.active]);
  const [section,setSection]=useState<Section>("prices"),[editing,setEditing]=useState<Editing>(null);
  const [id,setId]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  const rate=settings.rates.find(r=>r.id===id);
  const jobType=settings.templates.find(t=>t.id===id);
  const dirty=JSON.stringify(settings)!==JSON.stringify(saved);

  useEffect(()=>{
    if(!dirty)return;
    const protect=(e:BeforeUnloadEvent)=>e.preventDefault();
    window.addEventListener("beforeunload",protect);
    return ()=>window.removeEventListener("beforeunload",protect);
  },[dirty]);

  function open(edit:Editing,id=""){
    setId(id);setEditing(edit);setMessage("");setError("");
  }
  function cancel(){
    setSettings(saved);open(null);
  }
  function add(category: RateCategory = "labor"){
    if(section==="prices"){
      const next:ShopRate={id:crypto.randomUUID(),name:"",value:0,minimumCost:0,unit:category==="material"?"lb":category==="outside"?"job":"hour",category,group:group ? group as RateGroup : undefined,includes:"",source:"",effectiveOn:today};
      setSettings({...settings,rates:[...settings.rates,next]});open("price",next.id);
    }else{
      const next:EstimateTemplate={id:crypto.randomUUID(),name:"",workType:"",assumption:"",operations:[newStep(settings.rates[0].id)]};
      setSettings({...settings,templates:[...settings.templates,next]});open("type",next.id);
    }
  }
  function updateRate(patch:Partial<ShopRate>){
    setSettings({...settings,rates:settings.rates.map(r=>r.id===id?{...r,...patch}:r)});
  }
  function updateType(patch:Partial<EstimateTemplate>){
    setSettings({...settings,templates:settings.templates.map(t=>t.id===id?{...t,...patch}:t)});
  }
  function updateStep(opId:string,patch:Partial<TemplateOperation>){
    if(jobType)updateType({operations:jobType.operations.map(o=>o.id===opId?{...o,...patch}:o)});
  }
  async function save(next=settings){
    setBusy(true);setError("");
    try{
      const res=await fetch("/api/settings/estimating",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(next)});
      const data=await res.json();
      if(!res.ok)throw Error(data.error);
      setSettings(data);setSaved(data);setEditing(null);setId("");
      setProfiles(cur=>({...cur,[profile]:data, [profile==="shop"?"practice":"shop"]:{
        ...cur[profile==="shop"?"practice":"shop"],version:data.version,
      }}));
      setMessage(editing==="price"?"Shop prices saved.":editing==="type"?"Job types saved.":"Quote defaults saved.");router.refresh();
    }catch(e){setError(e instanceof Error?e.message:"Could not save. Try again.");}
    finally{setBusy(false);}
  }
  function remove(){
    if(!window.confirm("Remove "+(rate?.name||jobType?.name)+" from future quotes?"))return;
    void save(editing==="price"?{...settings,rates:settings.rates.filter(r=>r.id!==id)}:{...settings,templates:settings.templates.filter(t=>t.id!==id)});
  }
  function view(next: "shop" | "practice") {
    setProfile(next);
    setSettings(profiles[next]);
    setSaved(profiles[next]);
    setSearch("");
    chooseGroup("");
    open(null);
  }

  async function activate(){
    setBusy(true);setError("");
    try{
      const res=await fetch("/api/settings/estimating",{method:"PATCH",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({profile,version:saved.version})});
      const data: EstimatingProfiles & {error?:string}=await res.json();
      if(!res.ok)throw Error(data.error);
      setProfiles(data);
      setSettings(data[profile]);setSaved(data[profile]);
      setMessage(profile==="shop"?"New estimates now use your shop rates.":"New estimates now use U.S. practice rates.");
      router.refresh();
    }catch(e){setError(e instanceof Error?e.message:"Could not switch rates. Try again.");}
    finally{setBusy(false);}
  }

  function rateGroup(r: ShopRate): RateGroup {
    return r.group ?? ({material:"Stock",setup:"Labor",labor:"Labor",machine:"Machines",outside:"Outside services"} as const)[r.category];
  }
  const query=search.trim().toLowerCase();
  const filteredRates=settings.rates.filter(r=>(!group || rateGroup(r)===group) &&
    [r.name,r.grade,r.family,r.form,rateGroup(r),r.unit].some(value=>value?.toLowerCase().includes(query)));
  const filteredTypes=settings.templates.filter(t=>[t.name,t.workType].some(value=>value.toLowerCase().includes(query)));
  const counts=Object.fromEntries(rateGroups.map(key=>[key,settings.rates.filter(rate=>rateGroup(rate)===key).length]));
  const existing=editing==="price"?saved.rates.some(r=>r.id===id):saved.templates.some(t=>t.id===id);
  const inUse=!!rate&&settings.templates.some(t=>t.operations.some(o=>o.rateId===rate.id));
  const revisions=rate?history.filter(r=>r.id===id && r.demo===settings.demo):[];
  return <form onSubmit={event=>{event.preventDefault();if(editing)void save();}}>
    <fieldset disabled={busy} className="est-stack">
      {!editing&&<>
        <div className="est-picker" role="group" aria-label="Pricing profiles">
          <button type="button" className={profile==="shop"?"chosen":""} aria-pressed={profile==="shop"} onClick={()=>view("shop")}>My shop rates</button>
          <button type="button" className={profile==="practice"?"chosen":""} aria-pressed={profile==="practice"} onClick={()=>view("practice")}>U.S. practice rates</button>
        </div>
        <div className={"est-mode est-profile"+(profile==="practice"?" est-caution":"")}>
          <div><strong>{profile==="practice"?"U.S. practice rate book":"Your shop’s rate book"}</strong>
          <p>{profile==="practice" ? "Use these editable sample prices and job types to try estimates." : "Enter your supplier prices, shop costs and job types. Start with the work you quote most."}</p>
          <small>{profile===profiles.active ? "In use for new estimates" : "Viewing this rate book"}</small></div>
          {profile!==profiles.active && <button type="button" className="button primary" onClick={activate} disabled={!settings.rates.length}>
            {busy?<Activity>Switching</Activity>:profile==="shop"?"Use my shop rates":"Use practice rates"}</button>}
        </div>
        <div className="est-actions"><button type="button" className="button secondary" onClick={()=>open("defaults")}>Edit quote defaults</button>
          <span>{settings.defaultMargin ?? 25}% target margin · {settings.stockTrimPercent ?? 12}% stock trim allowance</span></div>
        {profile==="practice" && <details className="est-disclose est-practice-references"><summary>Sources and test assumptions</summary>
          <div className="est-detail-content"><p>Wage data and retail listings anchor the examples. Shop overhead, machine time, minimums and subcontract costs are editable allowances. Replace them with your own numbers for customer work.</p>
          <ul>{references.map(ref=><li key={ref.url}><a href={ref.url} target="_blank" rel="noreferrer">{ref.name}</a></li>)}</ul></div></details>}
        <div className="est-picker" aria-label="Shop settings"><button className={section==="prices"?"chosen":""} aria-pressed={section==="prices"} type="button" onClick={()=>{setSection("prices");setSearch("");setMessage("");}}>Shop prices</button>
          <button className={section==="types"?"chosen":""} aria-pressed={section==="types"} type="button" onClick={()=>{setSection("types");setSearch("");setMessage("");}}>Job types</button></div>
        <section className="panel" id="shop-prices"><div className="panel-heading"><h2>{section==="prices"?"Rate book":"Reusable job types"}</h2>
          {section==="types"&&<button type="button" className="button secondary push-right" disabled={!settings.rates.length} onClick={()=>add()}><Icon name="plus" size={17}/>Add job type</button>}</div>
          {section==="prices"&&<div className="est-pad est-stack est-rate-intro">
            <div className="est-actions">
              <button type="button" className="button primary" onClick={()=>add("material")}><Icon name="plus" size={17}/>Add material price</button>
              <button type="button" className="button secondary" onClick={()=>add("labor")}><Icon name="plus" size={17}/>Add hourly rate</button>
              <button type="button" className="button secondary" onClick={()=>add("outside")}><Icon name="plus" size={17}/>Add other cost</button>
            </div>
          </div>}
          <div className="est-pad est-rate-search">
            <Field label={section==="prices"?"Find a rate":"Find a job type"}><input type="search" value={search} onChange={event=>setSearch(event.target.value)}
              placeholder={section==="prices"?"Name, grade, material or unit":"Name or type of work"}/></Field>
            {section==="prices" && <Field label="Category"><select value={group} onChange={event=>chooseGroup(event.target.value)}>
              <option value="">All categories ({settings.rates.length})</option>
              {rateGroups.map(key=><option value={key} key={key}>{key} ({counts[key]})</option>)}</select></Field>}
          </div>
          {section==="prices" && !filteredRates.length && <p className="est-pad">{settings.rates.length?"No rates match these filters.":"Add your first price to start the shop rate book."}</p>}
          {section==="types" && !filteredTypes.length && <p className="est-pad">{settings.templates.length?"No job types match this search.":"Add a reusable job type after you enter a rate."}</p>}
          {section==="prices"?filteredRates.map(r=>{
            const active=effectiveRate(history,r.id,settings.demo,today),scheduled=r.effectiveOn && r.effectiveOn>today;
            return <button key={r.id} type="button" className="est-pick-row" onClick={()=>open("price",r.id)}>
              <span><strong>{r.name}</strong><small>{rateGroup(r)}{scheduled?" · New price starts "+r.effectiveOn:""}</small></span>
              <b>{active?formatRate(active.value)+" / "+active.unit:scheduled?"Scheduled":formatRate(r.value)+" / "+r.unit}</b><Icon name="chevron" size={16}/></button>;
          }):filteredTypes.map(t=><button key={t.id} type="button" className="est-pick-row" onClick={()=>open("type",t.id)}>
              <span><strong>{t.name}</strong><small>{t.operations.map(o=>o.label).join(" · ")}</small></span><Icon name="chevron" size={16}/></button>)}
        </section>
        {error&&<p className="error-banner" role="alert">{error}</p>}
        {message&&<p role="status" className="est-success"><Activity done>{message}</Activity></p>}
      </>}
      {editing&&<section className="panel">
        <div className="panel-heading"><h2>{editing==="defaults"?"Quote defaults":editing==="price"?(existing?rate?.name:"Add a shop price"):(existing?jobType?.name:"Add a job type")}</h2></div>
        <div className="est-pad est-stack">
        {editing==="defaults"&&<div className="est-grid">
          <DecimalField label="Target gross margin (%)" value={settings.defaultMargin??25} onChange={defaultMargin=>setSettings({...settings,defaultMargin})}/>
          <DecimalField label="Stock trim allowance (%)" value={settings.stockTrimPercent??12} onChange={stockTrimPercent=>setSettings({...settings,stockTrimPercent})}/>
          <DecimalField label="Takeoff budget contingency (%)" value={settings.budgetContingencyPercent??(settings.demo?15:0)}
            onChange={budgetContingencyPercent=>setSettings({...settings,budgetContingencyPercent})}/>
          <p className="est-wide">Stock trim adds purchased metal weight. Contingency covers uncertainty in the detailed budget and is applied before gross margin.</p>
        </div>}
        {editing==="price"&&rate&&<>
          <div className="est-grid">
            <Field label="Price name"><input autoFocus required placeholder="For example, welding labor" value={rate.name} onChange={e=>updateRate({name:e.target.value})}/></Field>
            <Field label="Type of cost"><select value={rate.category} onChange={e=>updateRate({category:e.target.value as RateCategory})}>{Object.entries(categories).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></Field>
            <Field label="Priced by the"><input value={rate.unit} required placeholder="hour, foot or piece" onChange={e=>updateRate({unit:e.target.value})}/></Field>
            <DecimalField label={"Price per "+(rate.unit||"unit")+" ($)"} value={rate.value} onChange={value=>updateRate({value,hourlyCost:undefined})}/>
            <Field label="Use this price starting"><input required type="date" value={rate.effectiveOn??""} onChange={e=>updateRate({effectiveOn:e.target.value})}/></Field>
            <DecimalField label="Minimum charge ($)" value={rate.minimumCost} onChange={minimumCost=>updateRate({minimumCost})}/>
            <Field label="Where did this price come from?" wide><input required maxLength={500} placeholder={rate.category==="material"?"Supplier or price sheet":"For example, Nick’s shop rate"} value={rate.source??""} onChange={e=>updateRate({source:e.target.value})}/></Field>
            <Field label="What does it cover?" wide><textarea required placeholder={rate.category==="material"?"For example, one 4 × 8 sheet of A36 steel":"For example, employee time, employer costs and overhead"} value={rate.includes} onChange={e=>updateRate({includes:e.target.value})}/></Field>
          </div>
          {rate.unit.trim().toLowerCase()==="hour" && <details className="est-disclose" open={!!rate.hourlyCost || undefined}>
            <summary>Build this rate from hourly costs</summary>
            <div className="est-grid est-detail-content">
              {(Object.keys(hourlyCostLabels) as (keyof HourlyCost)[]).map(key=><DecimalField key={key} label={hourlyCostLabels[key]+" ($/hr)"}
                value={rate.hourlyCost?.[key]??0} onChange={component=>{
                  const hourlyCost={...(rate.hourlyCost??{wage:0,burden:0,overhead:0,equipment:0}),[key]: component || 0};
                  updateRate({hourlyCost,value:hourlyTotal(hourlyCost)});
                }}/>)}
              <small>Use the total cost to the shop. The quote applies gross margin separately.</small>
            </div>
          </details>}
          <div className="est-grid">
            <Field label="Rate book category"><select value={rate.group??rateGroup(rate)} onChange={e=>updateRate({group:e.target.value as RateGroup})}>
              {rateGroups.map(key=><option key={key}>{key}</option>)}</select></Field>
            {rate.category==="material" && rateGroup(rate)==="Stock" && <>
              <Field label="Material family (optional)"><input value={rate.family??""} onChange={e=>updateRate({family:e.target.value})} placeholder="Carbon steel, stainless, aluminum"/></Field>
              <Field label="Grade or alloy (optional)"><input value={rate.grade??""} onChange={e=>updateRate({grade:e.target.value})} placeholder="A36, 304L, 5052-H32"/></Field>
              <Field label="Stock form (optional)"><select value={rate.form??""} onChange={e=>updateRate({form:(e.target.value||undefined) as ShopRate["form"]})}>
                <option value="">Choose a form</option>{stockForms.map(form=><option key={form}>{form}</option>)}</select></Field>
              <Field label="Density in lb/in³ (optional)"><input type="number" step=".0001" min=".0001" value={rate.density??""}
                onChange={e=>updateRate({density:e.target.value ? e.target.valueAsNumber : undefined})}/></Field>
              <Field label="Stock thickness in inches (optional)"><input type="number" step=".0001" min=".0001" value={rate.thicknessIn??""}
                onChange={e=>updateRate({thicknessIn:e.target.value ? e.target.valueAsNumber : undefined})}/></Field>
            </>}
            <Field label="Use for drawing budgets (optional)">
              <select value={rate.budgetRole??""} onChange={e=>updateRate({budgetRole:(e.target.value||undefined) as ShopRate["budgetRole"]})}>
                <option value="">Choose an operation</option>
                {budgetRoles.map(role=><option key={role} value={role}>{drawingRoles[role][0]}</option>)}</select></Field>
            {rate.budgetRole && <DecimalField label={drawingRoles[rate.budgetRole][1]+" "+drawingRoles[rate.budgetRole][3]}
              value={rate.budgetAmount??drawingRoles[rate.budgetRole][2]} onChange={budgetAmount=>updateRate({budgetAmount})}/>}
          </div>
          {revisions.length>0&&<details className="est-disclose"><summary>Earlier prices</summary><ul className="est-detail-content est-price-list">{revisions.map(r=><li key={r.version}>
            <b>{formatRate(r.value)} / {r.unit}</b> from {r.effectiveOn} · {r.source} {r.demo?"· Example price":""}</li>)}</ul></details>}
        </>}
        {editing==="type"&&jobType&&<>
          <div className="est-grid"><Field label="Job type name"><input required autoFocus value={jobType.name} placeholder="For example, cut steel plates" onChange={e=>updateType({name:e.target.value})}/></Field>
            <Field label="Kind of work"><input required value={jobType.workType} placeholder="For example, plate cutting" onChange={e=>updateType({workType:e.target.value})}/></Field>
            <Field label="Usual assumptions (optional)" wide><input value={jobType.assumption} onChange={e=>updateType({assumption:e.target.value})}/></Field></div>
          <h3>Usual work and materials</h3>
          {jobType.operations.map((op,n)=>{
            const unit=settings.rates.find(r=>r.id===op.rateId)?.unit||"unit";
            const added=!saved.templates.find(t=>t.id===id)?.operations.some(s=>s.id===op.id);
            return <details className="est-disclose est-work-card" key={op.id} open={added||undefined} onInvalidCapture={e=>{e.currentTarget.open=true;}}>
              <summary>{op.label||"New step "+(n+1)}</summary><div className="est-grid est-detail-content">
                <Field label="Name of step"><input required value={op.label} onChange={e=>updateStep(op.id,{label:e.target.value})}/></Field>
                <Field label="Which shop price?"><select value={op.rateId} onChange={e=>updateStep(op.id,{rateId:e.target.value})}>{settings.rates.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
                <Field label="How is the amount worked out?"><select value={op.driver} onChange={e=>updateStep(op.id,{driver:e.target.value as QuantityDriver})}>
                  {Object.entries(driverLabels).map(([v,label])=><option key={v} value={v}>{v==="fixed"?"Use the same amount each time":label}</option>)}</select></Field>
                <BasisField value={op.basis} onChange={basis=>updateStep(op.id,{basis})}/>
                {op.driver==="fixed"?<WorkAmountField unit={unit} basis={op.basis} value={op.amount} onChange={amount=>updateStep(op.id,{amount})}/>:
                  <DecimalField label={unit+" "+driverLabels[op.driver].toLowerCase()} value={op.amount} onChange={amount=>updateStep(op.id,{amount})}/>}
                <Field label="Notes about this step (optional)"><input value={op.assumption} onChange={e=>updateStep(op.id,{assumption:e.target.value})}/></Field>
                {jobType.operations.length>1&&<button type="button" className="text-button" onClick={()=>updateType({operations:jobType.operations.filter(o=>o.id!==op.id)})}>Remove this step</button>}
              </div></details>;
          })}
          <div><button type="button" className="button secondary" onClick={()=>updateType({operations:[...jobType.operations,newStep(settings.rates[0].id)]})}><Icon name="plus"/>Add work or material</button></div>
        </>}
        {error&&<p className="error-banner" role="alert">{error}</p>}
        <div className="est-actions"><button className="button primary" type="submit">{busy?<Activity>Saving</Activity>:editing==="price"?"Save price":editing==="type"?"Save job type":"Save setting"}</button>
          <button type="button" className="button secondary" onClick={cancel}>Cancel</button></div>
        {existing&&((editing==="price"&&!inUse&&settings.rates.length>0)||(editing==="type"&&settings.templates.length>0))&&<details className="est-disclose"><summary>Remove from future quotes</summary><div className="est-detail-content"><button className="text-button" type="button" onClick={remove}>Remove {editing==="price"?"this price":"this job type"}</button></div></details>}
        </div>
      </section>}
    </fieldset>
  </form>;
}
