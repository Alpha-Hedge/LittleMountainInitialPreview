import WorkspaceShell from "@/components/WorkspaceShell";
import { listQuotes } from "@/lib/quotes";
import { listApprovedVersions, getApprovalSnapshot } from "@/lib/workflow";
import { getJob } from "@/lib/jobs";
import "../workspace-pages.css";
import "./finished.css";
export const dynamic = "force-dynamic";
const money = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD" });
export default function JobsPage() {
  const jobs = listQuotes().flatMap((q) =>
    listApprovedVersions(q.id).map((v, index) => ({
      q: getApprovalSnapshot(q.id, v)!.quote,
      job: getJob(q.id, v),
      latest: index === 0,
    })),
  );
  function list(rows: typeof jobs) {
    return (
      <div className="finish-list">
        {rows.map(({ q, job }) => (
          <a href={"/jobs/" + q.id + "/" + q.version} key={q.id + q.version}>
            <div>
              <strong>{q.jobName}</strong>
              <small>
                {q.customer} · {q.number} · Approved copy {q.version}
              </small>
            </div>
            <div>
              <span>{job ? "Finished " + job.completedOn : money(q.totals.sellingPrice)}</span>
              <b>{job ? "View job record →" : "Add time and costs →"}</b>
            </div>
          </a>
        ))}
      </div>
    );
  }
  const earlier = jobs.filter((j) => !j.latest && !j.job);
  const waiting = jobs.filter((j) => j.latest && !j.job),
    completed = jobs.filter((j) => j.job);
  return (
    <WorkspaceShell
      active="jobs"
      breadcrumbs={[{ label: "Home", href: "/" }, { label: "Finished work" }]}
    >
      <div className="job-book">
        <div className="page-heading shelf-heading">
          <div>
            <h1>Finished jobs</h1>
            <p>Choose the job you finished to record what it took.</p>
          </div>
        </div>
        <section className="panel">
          <div className="panel-heading">
            <h2>Ready for hours and costs</h2>
          </div>
          {waiting.length ? (
            list(waiting)
          ) : (
            <div className="finish-body">
              <h3>{completed.length ? "All finished jobs are up to date" : "No approved jobs yet"}</h3>
              <p>
                {completed.length
                  ? "Other approved quotes will appear here."
                  : "After Nick approves a quote, you can record the time, materials and outside work here."}
              </p>
              <a href="/quotes" className="button secondary">
                Find a quote
              </a>
            </div>
          )}
        </section>
        {!!completed.length && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Saved job records</h2>
            </div>
            {list(completed)}
          </section>
        )}
        {!!earlier.length && (
          <details className="panel finish-fold">
            <summary>Earlier approved copies</summary>
            {list(earlier)}
          </details>
        )}
      </div>
    </WorkspaceShell>
  );
}
