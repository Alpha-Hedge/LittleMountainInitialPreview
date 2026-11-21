import { notFound } from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";
import { readApprovedEvidence } from "@/lib/cloud-history";
import { pricingDecisionLabels } from "@/lib/workflow-types";
import "@/app/job-history.css";
import "@/app/workspace-pages.css";

export const dynamic = "force-dynamic";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export default async function Evidence({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; workspace: string }>;
  searchParams: Promise<{ version?: string; edit?: string }>;
}) {
  const { id, workspace } = await params,
    q = await searchParams,
    version = Number(q.version);
  const evidence = await readApprovedEvidence(
    workspace,
    id,
    version,
    q.edit ? Number(q.edit) : undefined,
  );
  if (!evidence) notFound();
  const { snapshot, actual } = evidence,
    { quote, details, drawing } = snapshot;
  const file =
    "/api/learning/" + workspace + "/" + encodeURIComponent(id) + "/file?version=" + version + "&asset=";
  return (
    <WorkspaceShell
      active="jobs"
      breadcrumbs={[{ label: "Finished jobs", href: "/jobs" }, { label: "Past job" }]}
    >
      <div className="page-heading shelf-heading">
        <div>
          <h1>{quote.jobName}</h1>
          <p>
            {quote.customer} · {quote.number} · Approved version {version}
          </p>
        </div>
      </div>
      <div className="jh-metrics">
        <div>
          <small>Customer price</small>
          <strong>{usd.format(quote.totals.sellingPrice)}</strong>
        </div>
        <div>
          <small>Expected shop cost</small>
          <strong>{usd.format(quote.totals.estimatedCost)}</strong>
        </div>
      </div>
      <div className="jh-stack">
        <section className="panel jh-body">
          <h3>What the customer approved</h3>
          <p>{details.scope}</p>
          <p>
            {details.leadTime} · {details.terms}
          </p>
          {details.pricingDecision && (
            <p>
              {pricingDecisionLabels[details.pricingDecision.kind]} · {details.pricingDecision.reason}
            </p>
          )}
          <div className="jh-actions">
            <a href={file + "pdf"}>Approved PDF</a>
            {drawing && (
              <a href={file + "drawing"}>
                {drawing.fileName} · {drawing.label}
              </a>
            )}
          </div>
          {quote.items.map((item) => (
            <div key={item.id} className="jh-card">
              <h3>{item.description.split("\n")[0]}</h3>
              <p style={{ whiteSpace: "pre-line" }}>
                {item.description.split("\n").slice(1).join("\n")}
              </p>
              <p>Quantity {item.quantity}</p>
              {item.costRows.map((row) => (
                <p key={row.id}>
                  {row.label} · {row.amount} {row.estimate?.unit} · {usd.format(row.rate)} ·{" "}
                  {row.basis === "batch" ? "per batch" : "per part"}
                </p>
              ))}
            </div>
          ))}
        </section>
        <section className="panel jh-body">
          <h3>Completed work</h3>
          {actual ? (
            <>
              <p>
                {actual.completedOn} · Actuals edit {actual.edit}
              </p>
              {actual.rows.map((r, i) => (
                <p key={i}>
                  {r.operation} · {r.amount} {r.unit} total
                  {r.unitCost !== null ? " at " + usd.format(r.unitCost) + " per " + r.unit : ""}
                  {r.exceptionReason ? " · " + r.exceptionReason : ""}
                </p>
              ))}
              {actual.scopeChanges && <p>Scope changes · {actual.scopeChanges}</p>}
              {actual.overrideReasons && <p>Exceptions · {actual.overrideReasons}</p>}
            </>
          ) : (
            <p>Actuals have yet to be recorded for this approval.</p>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
