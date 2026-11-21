import { quoteResponse } from "@/app/api/quotes/_http";
import { cloudStatus, syncLearningHistory } from "@/lib/cloud-history";
export async function POST() {
  return quoteResponse(async () => {
    await syncLearningHistory();
    return cloudStatus();
  });
}
