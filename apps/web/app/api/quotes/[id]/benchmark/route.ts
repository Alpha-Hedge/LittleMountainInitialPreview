import { fillBenchmark } from "@/lib/benchmark";
import { getDrawingState } from "@/lib/drawings";
import { blueprintOrigin } from "@/lib/engineering-ledger";
import { getEstimatingSettings } from "@/lib/estimating";
import { getQuote, QuoteError, updateQuote } from "@/lib/quotes";
import { getWorkflowStatus } from "@/lib/workflow";
import { quoteResponse, readJson } from "../../_http";
import { checkDeskOrigin } from "../../../assistant/_http";

export const runtime = "nodejs";

export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return quoteResponse(async () => {
    checkDeskOrigin(request);
    const {id} = await context.params;
    const input = await readJson(request) as {version?: number} | null;
    const quote = getQuote(id);
    if (!quote || quote.version !== input?.version) throw new QuoteError("Reopen the current quote before adding benchmark costs.", 409);
    const origin = blueprintOrigin(id);
    const selected = getDrawingState(id).selectedRevisionId;
    const rates = getEstimatingSettings();
    if (getWorkflowStatus(id, quote.version) !== "draft" || !origin || origin.selectedRevision !== selected ||
        origin.job.result || (rates.demo && origin.job.settings.demo !== true)) {
      throw new QuoteError("Budget costs are available for editable drawing drafts with compatible rates.", 409);
    }
    if (quote.benchmark) return quote;
    const priced = fillBenchmark(quote, origin.job, selected, rates);
    if (!priced.benchmark) throw new QuoteError("There are no unpriced drawing lines eligible for a benchmark estimate.", 422);
    return updateQuote(id, priced);
  });
}
