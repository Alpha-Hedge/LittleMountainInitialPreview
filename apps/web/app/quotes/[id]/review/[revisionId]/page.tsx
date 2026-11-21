import { notFound } from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";
import DrawingReview from "@/components/DrawingReview";
import { getQuote } from "@/lib/quotes";
import { getDrawingState } from "@/lib/drawings";
import { listReviews } from "@/lib/reviews";
import "@/app/workspace-pages.css";

export const dynamic = "force-dynamic";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; revisionId: string }>;
  searchParams: Promise<{ read?: string | string[] }>;
}) {
  const { id, revisionId } = await params;
  const query = await searchParams;
  const quote = getQuote(id);
  if (!quote) notFound();
  const state = getDrawingState(id);
  const revision = state.attachments
    .flatMap((a) => a.revisions)
    .find((r) => r.id === revisionId);
  if (!revision) notFound();
  return (
    <WorkspaceShell
      active="drawings"
      drawingsHref={"/quotes/" + id + "#drawings"}
      breadcrumbs={[
        { label: "Quotes", href: "/quotes" },
        { label: quote.number, href: "/quotes/" + id },
        { label: "Drawing review" },
      ]}
    >
      <DrawingReview
        quote={quote}
        revision={revision}
        active={state.selectedRevisionId === revision.id}
        savedRuns={listReviews(id, revisionId)}
        autoRead={query.read === "1"}
      />
    </WorkspaceShell>
  );
}
