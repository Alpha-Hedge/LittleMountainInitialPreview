import { frozenInternalCostSheet, issueInternalCostSheet, renderInternalCostSheet } from "@/lib/internal-cost-sheet";
import { QuoteError } from "@/lib/quotes";
import { getApprovedPackage, getApprovalSnapshot, getQuoteReview } from "@/lib/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function costSheet(id: string, version: number) {
  const frozen = frozenInternalCostSheet(id, version);
  if (frozen) return frozen;
  // Quotes approved by earlier releases already retain their issued prices and versioned inputs.
  if (getApprovalSnapshot(id, version)) {
    const approved = getApprovedPackage(id, version);
    issueInternalCostSheet(approved.quote, approved.customer);
    return frozenInternalCostSheet(id, version)!;
  }
  const review = getQuoteReview(id, version);
  return {filename: review.snapshot.quote.number + "-v" + version + "-internal-costs.csv",
    csv: renderInternalCostSheet(review.snapshot.quote, review.customer)};
}

export async function GET(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const raw = new URL(request.url).searchParams.get("version");
  const version = Number(raw);
  if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(version) || version < 1)
    return Response.json({error: "Choose a saved quote version."}, {status: 400});
  try {
    const sheet = costSheet(id, version);
    return new Response(sheet.csv, {headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + sheet.filename + '"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    }});
  } catch (error) {
    if (error instanceof QuoteError) return Response.json({error: error.message}, {status: error.status});
    throw error;
  }
}

