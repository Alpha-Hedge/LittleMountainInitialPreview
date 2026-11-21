import { quoteResponse, readJson } from "../quotes/_http";
import { reviewWithAssistant } from "@/lib/review-assistant";
import { checkDeskOrigin } from "./_http";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return quoteResponse(async () => {
    checkDeskOrigin(request);
    return reviewWithAssistant(await readJson(request));
  });
}
