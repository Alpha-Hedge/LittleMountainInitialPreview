import WorkspaceShell from "./WorkspaceShell";
import { Icon } from "./Icons";
import SavedQuotes from "./SavedQuotes";
import { listQuotes } from "@/lib/quotes";
import { getWorkflowStatus } from "@/lib/workflow";
import { needsAutomaticBudget } from "@/lib/drawing-takeoff";
import "@/app/quote-desk.css";

const savedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/New_York",
});
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const tools = [
  { title: "Sketch to drawing", description: "Turn a hand sketch into a shop drawing and cut files.", href: "/sketches", icon: "sketch" },
  { title: "Drawing reviews", description: "Check the scope and measurements on a customer drawing.", href: "/blueprints", icon: "blueprint" },
] as const;

export function QuoteDesk() {
  const rows = listQuotes().map((q) => {
    const status = getWorkflowStatus(q.id, q.version);
    const waitingForBudget = status === "draft" && q.benchmark && needsAutomaticBudget(q);
    const priced =
      status !== "draft" ||
      q.items.some((i) => i.costRows.some((r) => r.rate > 0 || (r.estimate?.minimumCost ?? 0) > 0));
    return {
      id: q.id,
      name: q.jobName,
      customer: q.customer,
      number: q.number,
      status,
      date: savedDate.format(new Date(q.updatedAt)),
      price: priced && !waitingForBudget ? q.totals.sellingPrice : null,
      example: q.id === "demo-mounting-plate",
      version: q.version,
    };
  });
  const recent = rows.find(row => row.status === "draft" && !row.example) ?? rows.find(row => row.status === "draft");
  return (
    <WorkspaceShell breadcrumbs={[{ label: "Quote desk" }]}>
      <header className="desk-heading">
        <div>
          <h1>Quote desk</h1>
          <p>Start an estimate or pick up where you left off.</p>
        </div>
        <a className="button primary desk-start" href="/quotes/new"><Icon name="plus" size={18}/>Start a quote</a>
      </header>
      <div className="desk-overview" data-has-draft={Boolean(recent)}>
        {recent && <section className="desk-resume" aria-label="Most recently edited draft">
          <div className="desk-card-top">
            <span className="desk-feature-icon"><Icon name="quotes" size={21}/></span>
            <span className="desk-resume-label">Latest draft · {recent.number}</span>
          </div>
          <div className="desk-resume-copy">
            <h2>{recent.name}</h2>
            <p>{recent.customer === "Customer not entered" ? "Customer to confirm" : recent.customer} · Saved {recent.date}</p>
          </div>
          <div className="desk-resume-footer">
            <div className="desk-resume-price">
              <span>Estimated selling price</span>
              <strong>{recent.price === null ? "No price yet" : dollars.format(recent.price)}</strong>
            </div>
            <a href={"/quotes/" + encodeURIComponent(recent.id)}>Continue estimate <Icon name="arrow" size={16}/></a>
          </div>
        </section>}
        <nav className="desk-tools" aria-label="Drawing tools">
          {tools.map(tool => <a key={tool.href} className="desk-tool" href={tool.href}>
            <span className="desk-card-top">
              <span className="desk-feature-icon"><Icon name={tool.icon} size={22}/></span>
              <span className="desk-tool-arrow"><Icon name="arrow" size={17}/></span>
            </span>
            <span className="desk-tool-copy"><strong>{tool.title}</strong><small>{tool.description}</small></span>
          </a>)}
        </nav>
      </div>
      <SavedQuotes rows={rows} />
    </WorkspaceShell>
  );
}
