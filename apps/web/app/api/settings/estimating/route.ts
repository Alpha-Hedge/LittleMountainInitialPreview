import { getEstimatingSettings, saveEstimatingSettings, selectEstimatingProfile } from "@/lib/estimating";
import { quoteResponse, readJson } from "../../quotes/_http";
import { checkDeskOrigin } from "../../assistant/_http";

export const runtime = "nodejs";

export function GET() {
  return quoteResponse(getEstimatingSettings);
}

export function PUT(request: Request) {
  return quoteResponse(async () => {
    checkDeskOrigin(request);
    return saveEstimatingSettings(await readJson(request), true);
  });
}

export function PATCH(request: Request) {
  return quoteResponse(async () => {
    checkDeskOrigin(request);
    return selectEstimatingProfile(await readJson(request));
  });
}
