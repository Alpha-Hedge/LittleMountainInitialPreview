import { notFound } from "next/navigation";
import { getQuote } from "@/lib/quotes";
import { getDrawingState } from "@/lib/drawings";
import { listReviews } from "@/lib/reviews";
import { sourceSketchId } from "@/lib/sketch/quote-link";
import QuoteEditor from "@/components/QuoteEditor";
import { getWorkflowStatus } from "@/lib/workflow";
import { blueprintOrigin } from "@/lib/engineering-ledger";
import { getEstimatingSettings } from "@/lib/estimating";
import { needsAutomaticBudget } from "@/lib/drawing-takeoff";

export const dynamic = "force-dynamic";
export default async function QuotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const quote = getQuote((await params).id);
  if (!quote) notFound();
  const initialStatus = getWorkflowStatus(quote.id, quote.version);
  const drawing = getDrawingState(quote.id).selectedRevisionId;
  const reviewed =
    drawing && listReviews(quote.id, drawing).some((run) => run.appliedAt);
  const blueprint = blueprintOrigin(quote.id);
  const rates = getEstimatingSettings();
  return (
    <QuoteEditor
      initialQuote={quote}
      initialStatus={initialStatus}
      initialDrawingId={drawing}
      reviewedDrawingId={reviewed || blueprint?.selectedRevision === drawing ? drawing : null}
      sketchId={sourceSketchId(quote.id)}
      hasBlueprint={!!blueprint}
      canApplyBenchmark={initialStatus === "draft" && !!blueprint &&
        blueprint.selectedRevision === drawing && !blueprint.job.result &&
        (blueprint.job.settings.demo === true || !rates.demo)}
      usePracticeRates={rates.demo}
      canBuildTakeoff={initialStatus === "draft" && !!drawing && !blueprint?.job.result}
      automaticTakeoff={initialStatus === "draft" && !!drawing && needsAutomaticBudget(quote) &&
        (blueprint ? blueprint.selectedRevision === drawing && !blueprint.job.result : !!reviewed)}
      contingencyDefault={rates.budgetContingencyPercent ?? (rates.demo ? 15 : 0)}
    />
  );
}
