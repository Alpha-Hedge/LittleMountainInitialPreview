import { notFound } from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";
import QuoteReviewWorkspace from "@/components/QuoteReviewWorkspace";
import { getQuoteReview } from "@/lib/workflow";
import { blueprintOrigin, reviewOperations } from "@/lib/engineering-ledger";
import { sourceSketchId } from "@/lib/sketch/quote-link";
import { QuoteError } from "@/lib/quotes";
import "@/app/workspace-pages.css";
export const dynamic = "force-dynamic";
export default async function Workspace({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { id } = await params,
    raw = (await searchParams).version,
    v = raw === undefined ? undefined : Number(raw);
  if (v !== undefined && (!Number.isSafeInteger(v) || v < 1)) notFound();
  let view;
  try {
    view = getQuoteReview(id, v);
  } catch (e) {
    if (e instanceof QuoteError && e.status === 404) notFound();
    throw e;
  }
  const origin = blueprintOrigin(id);
  const sketch = view.snapshot.reviewRuns.some(
    (r) =>
      r.provider === "Shop drawing" &&
      r.revisionId === view.snapshot.drawing?.id,
  )
    ? sourceSketchId(id)
    : null;
  return (
    <WorkspaceShell
      active="quotes"
      breadcrumbs={[
        { label: "Quotes", href: "/quotes" },
        { label: view.snapshot.quote.number, href: "/quotes/" + id },
        { label: "Drawing & quote workspace" },
      ]}
    >
      <QuoteReviewWorkspace
        key={view.snapshot.quote.version}
        view={view}
        operations={reviewOperations(view.snapshot.quote)}
        blueprint={
          origin &&
          (view.snapshot.drawing?.id ?? null) === origin.selectedRevision
            ? origin.job
            : null
        }
        sketch={sketch}
      />
    </WorkspaceShell>
  );
}
