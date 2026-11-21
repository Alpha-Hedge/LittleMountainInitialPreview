import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import EstimateBuilder from "@/components/EstimateBuilder";
import { SavedRoutingBasis } from "@/components/SavedRoutingBasis";
import { formatRate, formatUSD } from "@/components/EstimatingFields";
import { Icon } from "@/components/Icons";
import { getEstimatingSettings } from "@/lib/estimating";
import { previewEstimate } from "@/lib/history";
import { getQuote, getQuoteVersion, listQuoteVersions } from "@/lib/quotes";
import type { Quote } from "@/lib/types";
import "../../../estimating.css";

export const dynamic = "force-dynamic";
type Query = { version?: string; itemId?: string; templateId?: string; justSaved?: string };

function SavedInputs({quote}: {quote: Quote}) {
  return <details className="panel est-disclose est-panel-details"><summary>See the costs saved with this quote</summary>
    <div className="est-pad est-stack">{quote.items.map(item => <div className="est-card" key={item.id}>
      <div className="est-card-head"><h3>{item.description.split("\n")[0]}</h3><b>Qty {item.quantity}</b></div>
      {item.costRows.length === 0 && <p className="est-muted">No cost rows saved.</p>}
      <SavedRoutingBasis quoteId={quote.id} item={item} version={quote.version}/>
      {item.costRows.map(row => <div key={row.id} className="est-frozen">
        <div className="est-card-head"><strong>{row.label}</strong><b>{formatUSD(quote.totals.items.find(i => i.id === item.id)!.rows.find(r => r.id === row.id)!.cost)}</b></div>
        <p>{row.amount} {row.estimate?.unit} × {formatRate(row.rate)} · {row.basis === "batch" ? "Once per batch" : "Per part"}</p>
        {row.estimate && <><p>{row.estimate.templateName} · {row.estimate.demo ? "Demo rate book" : "Rate book"} v{row.estimate.settingsVersion} · {formatRate(row.estimate.minimumCost)} minimum</p>
          {row.estimate.rateSource && <p>Rate source · {row.estimate.rateSource} · effective {row.estimate.rateEffectiveOn} · book v{row.estimate.rateSettingsVersion}</p>}
          <p>{row.estimate.rationale}</p><p>Includes {row.estimate.includes}</p>{row.estimate.assumption && <p>{row.estimate.assumption}</p>}
          {row.estimate.overrideReason && <p><b>Override reason</b> · {row.estimate.overrideReason}</p>}</>}
      </div>)}</div>)}</div>
    <div className="selling-price"><div><span>Suggested selling price</span><small>{formatUSD(quote.totals.estimatedCost)} estimated cost · {quote.marginPercent}% margin · Before tax</small></div>
      <strong>{formatUSD(quote.totals.sellingPrice)}</strong></div>
  </details>;
}

export default async function EstimatePage({params, searchParams}: {params: Promise<{id: string}>; searchParams: Promise<Query>}) {
  const { id } = await params;
  const query = await searchParams;
  const current = getQuote(id);
  if (!current) notFound();
  const version = query.version ? Number(query.version) : null;
  if (query.version && (!Number.isSafeInteger(version) || Number(version) < 1)) notFound();
  const quote = version ? getQuoteVersion(id, version) : current;
  if (!quote) notFound();
  const path = "/quotes/" + encodeURIComponent(id);
  const settings = getEstimatingSettings();
  const itemId = current.items.find(i => i.id === query.itemId)?.id ?? current.items[0].id;
  const templateId = settings.templates.find(t => t.id === query.templateId)?.id ?? settings.templates[0]?.id;
  const justSaved = query.justSaved === "1" && quote.version === current.version;
  const nextItem = justSaved ? quote.items.find(item => item.costRows.length === 0) : undefined;
  const estimateHref = path + "/estimate";
  const reviewHref = path + "/approval?version=" + quote.version;
  return <WorkspaceShell breadcrumbs={[{label:"Quotes",href:"/quotes"},{label:quote.number,href:path},{label:"Estimate"}]} drawingsHref={path+"#drawings"}>
    <div className="est-workspace"><header className="est-heading"><div>{!version && <a className="est-back" href={path}>Back to quote</a>}<h1>{version ? (justSaved?"Costs saved to quote":"Saved price") : "Price the work"}</h1>
      <p>{quote.jobName} · {quote.customer} · {quote.number}</p></div></header>
      {version ? <div className="est-stack"><section className="panel est-pad est-stack"><div className="est-sale"><small>{nextItem ? "Price so far before tax" : "Customer price before tax"} · Version {quote.version}</small><strong>{formatUSD(quote.totals.sellingPrice)}</strong></div>
        {nextItem && <p>Next, add costs for <strong>{nextItem.description.split("\n")[0]}</strong>.</p>}
        <div className="est-actions">
          {nextItem ? <>
            <a className="button primary" href={estimateHref+"?"+new URLSearchParams({itemId:nextItem.id})}>Price next item <Icon name="arrow" size={17}/></a>
            <a className="button secondary" href={path+"#part-"+nextItem.id}>Enter its costs by hand</a>
          </> : <>
            <a className="button primary" href={reviewHref}>Review this quote <Icon name="arrow" size={17}/></a>
            <a className="button secondary" href={justSaved ? path+"#parts" : path}>{justSaved ? "Add delivery or other costs" : "Back to current quote"}</a>
            <a href={estimateHref}>Change costs</a>
          </>}
        </div></section><SavedInputs quote={quote}/></div>
        : <>
          <section className={"est-mode est-pricing-intro"+(settings.demo?" est-caution":"")}>
            <div><strong>{settings.demo ? "Example shop rates" : "Using your shop rates"}</strong>
              <p>{settings.demo ? "Use these for practice. Nick enters the real material prices and hourly shop rates in Shop settings." : "Materials are priced by what you use. Labor and machine time use the hours on this job and your shop rates."}</p>
            </div>
            <a className="button secondary" href="/settings#shop-prices">Open shop rates</a>
          </section>
          {templateId ? <EstimateBuilder quote={current} settings={settings} initialItem={itemId} initialTemplate={templateId}
            initialSuggestion={await previewEstimate(id,itemId,templateId)}/> :
            <section className="panel est-pad"><h2>Add a job type to start</h2>
              <p>Create a reusable job type with your saved rates in Shop settings, or enter costs directly on the quote.</p>
              <a className="button secondary" href={path+"#parts"}>Enter costs on quote</a>
            </section>}
        </>}
      <details className="panel est-versions est-disclose est-panel-details"><summary>Earlier saved prices</summary>
        <div className="est-pad">{listQuoteVersions(id).map(v =>
          <a key={v.version} aria-current={v.version === version ? "page" : undefined} href={path+"/estimate?version="+v.version}>
            <strong>Version {v.version}</strong><span>{v.version === current.version ? "Current" : "Saved"}</span><b>{formatUSD(v.totals.sellingPrice)}</b></a>)}</div>
      </details>
    </div>
  </WorkspaceShell>;
}
