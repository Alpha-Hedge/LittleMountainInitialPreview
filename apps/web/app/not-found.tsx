import WorkspaceShell from "@/components/WorkspaceShell";
export default function NotFound() {
  return (
    <WorkspaceShell breadcrumbs={[{ label: "Page unavailable" }]}>
      <div className="page-heading">
        <h1>We couldn’t find that page</h1>
      </div>
      <p>Open the quote desk and look for the job or customer.</p>
      <p style={{ marginTop: 18 }}>
        <a className="button primary" href="/">
          Go to quote desk
        </a>
      </p>
    </WorkspaceShell>
  );
}
