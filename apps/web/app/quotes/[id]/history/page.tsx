import { notFound } from "next/navigation";
import { getQuote } from "@/lib/quotes";
import { getEstimatingSettings, suggestOperations } from "@/lib/estimating";
import { historyContext, historyArchive, listProposals } from "@/lib/history";
import WorkspaceShell from "@/components/WorkspaceShell";
import HistoryEstimate from "@/components/HistoryEstimate";
import "../../../workspace-pages.css";
import "../../../job-history.css";
import "../../../estimating.css";

export const dynamic = "force-dynamic";
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ itemId?: string; templateId?: string; run?: string }>;
}) {
  const { id } = await params,
    query = await searchParams;
  const quote = getQuote(id);
  if (!quote) notFound();
  const settings = getEstimatingSettings(),
    itemId = query.itemId || quote.items[0].id,
    templateId = query.templateId || settings.templates[0]?.id || "";
  const available =
    quote.items.some((i) => i.id === itemId) && settings.templates.some((t) => t.id === templateId);
  const archive = historyArchive(id, itemId, templateId, query.run);
  const entries = archive.entries,
    run = query.run || !available ? archive.run : null;
  if (!templateId && !run) return (
    <WorkspaceShell breadcrumbs={[{label:"Quotes",href:"/quotes"},{label:quote.number,href:"/quotes/"+id},{label:"Past work"}]}>
      <div className="est-workspace"><section className="panel est-pad"><h1>Add a job type to use past work</h1>
        <p>Choose the rates and operations you want to compare in Shop settings.</p>
        <a className="button primary" href="/settings">Open Shop settings</a>
      </section></div>
    </WorkspaceShell>
  );
  if ((!available || query.run) && !run) notFound();
  let context;
  try {
    context = run
      ? { ...run, base: available ? suggestOperations(id, itemId, templateId) : run.base }
      : await historyContext(id, itemId, templateId);
  } catch (error) {
    return (
      <WorkspaceShell
        breadcrumbs={[
          { label: "Quotes", href: "/quotes" },
          { label: quote.number, href: "/quotes/" + id },
          { label: "Job comparisons" },
        ]}
      >
        <section className="panel jh-body">
          <h1>Job history unavailable</h1>
          <p role="alert">
            {error instanceof Error ? error.message : "Could not read the saved comparisons."}
          </p>
          <a className="button secondary" href={"/quotes/" + id + "/estimate"}>
            Back to pricing
          </a>
        </section>
      </WorkspaceShell>
    );
  }
  const { base, records, observations, recordsSource } = context;
  const url = "/quotes/" + id + "/history?" + new URLSearchParams({ itemId, templateId });
  return (
    <WorkspaceShell
      active="quotes"
      breadcrumbs={[
        { label: "Quotes", href: "/quotes" },
        { label: quote.number, href: "/quotes/" + id },
        { label: "Job comparisons" },
      ]}
    >
      <div className="pricing-history"><div className="page-heading shelf-heading">
        <div>
          <h1>Time on past jobs</h1>
          <p>{quote.jobName} · {quote.customer}</p>
        </div>
        <a className="button secondary" href={"/quotes/" + id + "/estimate?"+new URLSearchParams({itemId,templateId})}>
          Back to pricing
        </a>
      </div>
      <details className="panel jh-body"><summary>Change the part or job type</summary>
        <form className="jh-fields" method="get">
          <label className="field">
            Part or service
            <select name="itemId" defaultValue={itemId}>
              {quote.items.map((i, n) => (
                <option key={i.id} value={i.id}>
                  {n + 1}. {i.description.split("\n")[0]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Job type
            <select name="templateId" defaultValue={templateId}>
              {settings.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <div className="jh-actions">
            <button className="button secondary">Find similar jobs</button>
          </div>
        </form>
      </details>
      <HistoryEstimate
        key={url + ":" + run?.id}
        quoteId={id}
        itemId={itemId}
        templateId={templateId}
        base={base}
        records={records}
        observations={observations || []}
        recordsSource={recordsSource}
        run={run}
        proposals={run ? listProposals(run.id) : []}
        url={url}
        archived={!available}
      />
      {entries.length > 0 && (
        <details className="panel jh-body">
          <summary>Earlier suggestions ({entries.length})</summary>
          {entries.map((e) => (
            <p key={e.id}>
              <a href={url + "&run=" + e.id}>
                {new Date(e.createdAt).toLocaleString("en-US")} ·{" "}
                {e.version ? "Applied to v" + e.version : "Review copy"}
              </a>
            </p>
          ))}
        </details>
      )}</div>
    </WorkspaceShell>
  );
}
