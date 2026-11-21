import { readJson, quoteResponse } from "@/app/api/quotes/_http";
import { generateHistory, applyHistory, decideProposal } from "@/lib/history";
import type { HourEdit, MeasureEdit } from "@/lib/history-types";
import { QuoteError } from "@/lib/quotes";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return quoteResponse(async () => {
    const body = (await readJson(request)) as {
      action: string;
      itemId: string;
      templateId: string;
      runId: string;
      edits: HourEdit[];
      measures?: MeasureEdit[];
      proposalId: string;
    };
    if (
      (body?.action === "generate" || body?.action === "review_defaults") &&
      typeof body.itemId === "string" &&
      typeof body.templateId === "string"
    )
      return generateHistory(
        id,
        body.itemId,
        body.templateId,
        body.action === "review_defaults" ? "template_review" : "estimate",
      );
    if (body?.action === "apply" && typeof body.runId === "string")
      return applyHistory(id, body.runId, body.edits, body.measures);
    if (["approve", "decline"].includes(body?.action) && typeof body.proposalId === "string")
      return decideProposal(id, body.proposalId, body.action === "approve");
    throw new QuoteError("Choose a valid estimate action.");
  });
}
