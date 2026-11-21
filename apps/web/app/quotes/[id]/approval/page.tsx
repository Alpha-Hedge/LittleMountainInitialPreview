import { notFound } from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";
import QuoteApproval from "@/components/QuoteApproval";
import { getQuoteReview } from "@/lib/workflow";
import { QuoteError } from "@/lib/quotes";
import { blueprintOrigin } from "@/lib/engineering-ledger";
import { appliedEvidence } from "@/lib/history";
import "@/app/workspace-pages.css";
import "./review.css";

export const dynamic="force-dynamic";

export default async function QuoteApprovalPage({params,searchParams}:{
  params:Promise<{id:string}>;
  searchParams:Promise<{version?:string|string[]}>;
}){
  const {id}=await params;
  const {version:raw}=await searchParams;
  const version=raw===undefined ? undefined:Number(raw);
  if(version!==undefined && (Array.isArray(raw)||!Number.isSafeInteger(version)||version<1))notFound();
  let view;
  try{view=getQuoteReview(id,version);}
  catch(error){if(error instanceof QuoteError&&error.status===404)notFound();throw error;}
  const path="/quotes/"+encodeURIComponent(id);
  const evidence=appliedEvidence(view.snapshot.quote);
  return <WorkspaceShell drawingsHref={path+"#drawings"} breadcrumbs={[
    {label:"Quotes",href:"/quotes"},{label:view.snapshot.quote.number,href:path},{label:"Quote review"},
  ]}><a className="button secondary" href={path+"/workspace?version="+view.snapshot.quote.version}>Drawing &amp; quote workspace</a>{blueprintOrigin(id) && <p><a href={path+"/blueprint"}>View drawing and original estimate</a></p>}<QuoteApproval initial={view}/>{evidence.length>0&&<details className="panel approval-fold"><summary>Past jobs used to set the price</summary><div className="review-actions">{evidence.map(link=><p key={link.href}><a href={link.href}>{link.label}</a></p>)}</div></details>}</WorkspaceShell>;
}
