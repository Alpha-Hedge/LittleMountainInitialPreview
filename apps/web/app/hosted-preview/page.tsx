import { notFound } from "next/navigation";
import { Icon } from "@/components/Icons";
import WorkspaceShell, { type ShellProps } from "@/components/WorkspaceShell";
import { isHostedPreview } from "@/lib/hosted-preview";
import "./preview.css";

export const dynamic = "force-dynamic";

const sections = new Map<string, { title: string; active: ShellProps["active"]; description: string }>([
  ["sketches", { title: "Sketch to drawing", active: "sketches", description: "On the shop desk, upload a photo of a hand sketch, check the measurements, and download the drawing and cut files." }],
  ["blueprints", { title: "Drawing reviews", active: "blueprints", description: "On the shop desk, review the parts and measurements from a customer drawing before pricing the job." }],
  ["inbox", { title: "Customer emails", active: "inbox", description: "On the shop desk, import a request and keep its messages with the quote." }],
  ["jobs", { title: "Finished jobs", active: "jobs", description: "On the shop desk, record actual hours and costs when the work is done." }],
  ["settings", { title: "Shop settings", active: "settings", description: "On the shop desk, set material costs, hourly rates, and templates for new quotes." }],
  ["learning", { title: "Quote history", active: "jobs", description: "On the shop desk, review the past work and costs used to inform an estimate." }],
]);

const examplePath = "/quotes/demo-mounting-plate";

export default async function HostedPreview({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  if (!isHostedPreview()) notFound();

  const { section } = await searchParams;
  const area = section ? sections.get(section) : undefined;
  const example = section === "example";
  const title = area?.title ?? (example ? "Mounting plate assembly" : "Quote desk");

  return (
    <WorkspaceShell active={area?.active} breadcrumbs={[{ label: title }]}>
      <section className="hosted-preview" aria-labelledby="hosted-preview-title">
        <header className="hosted-preview-heading">
          <span className="hosted-preview-badge">Read-only preview</span>
          <h1 id="hosted-preview-title">{title}</h1>
          <p>{area?.description ?? (example ? "Sample estimate for 10 fabricated mounting plates and one delivery." : "Explore a sample estimate and see how the shop builds a quote.")}</p>
        </header>
        {example ? (
          <div className="panel hosted-preview-card">
            <h2>Sample estimate</h2>
            <dl className="hosted-preview-costs">
              <div><dt>Plate material · 10 × $8.00</dt><dd>$80.00</dd></div>
              <div><dt>Fabrication labor · 1.5 hours × $60.00</dt><dd>$90.00</dd></div>
              <div><dt>Local delivery · once per order</dt><dd>$30.00</dd></div>
              <div><dt>Estimated shop cost</dt><dd>$200.00</dd></div>
              <div className="hosted-preview-total"><dt>Suggested selling price at 25% gross margin</dt><dd>$266.67</dd></div>
            </dl>
            <p>Before tax. Sample rates and quantities.</p>
          </div>
        ) : !area && (
          <a className="panel hosted-preview-card hosted-preview-example" href={examplePath}>
            <span className="hosted-preview-icon"><Icon name="quotes" size={22} /></span>
            <span><strong>Mounting plate assembly</strong><small>10 fabricated parts and one delivery</small></span>
            <span className="hosted-preview-example-price"><strong>$266.67</strong><Icon name="arrow" size={16} /></span>
          </a>
        )}
        <footer className="hosted-preview-footer">
          <p>Quote saving and drawing uploads are available on the shop desk.</p>
          <a className="button secondary" href={example ? "/" : "/help"}>{example ? "Back to quote desk" : "Open quick guide"}<Icon name="arrow" size={16} /></a>
        </footer>
      </section>
    </WorkspaceShell>
  );
}
