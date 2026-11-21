import { quoteResponse, readJson } from "@/app/api/quotes/_http";
import { getJob, saveJob, parseActualsCsv } from "@/lib/jobs";
import { getApprovalSnapshot } from "@/lib/workflow";
import { QuoteError } from "@/lib/quotes";
import type { JobRecord } from "@/lib/job-types";

type Context = { params: Promise<{ id: string; version: string }> };
export async function GET(_: Request, { params }: Context) {
  const { id, version } = await params;
  return quoteResponse(() => getJob(id, Number(version)));
}
export async function PUT(request: Request, { params }: Context) {
  const { id, version } = await params;
  return quoteResponse(async () => saveJob(id, Number(version), (await readJson(request)) as JobRecord));
}
export async function POST(request: Request, { params }: Context) {
  const { id, version } = await params;
  return quoteResponse(async () => {
    const approval = getApprovalSnapshot(id, Number(version));
    if (!approval) throw new QuoteError("Approved version not found.", 404);
    const body = (await readJson(request)) as { csv: string };
    return { rows: parseActualsCsv(body?.csv, approval.quote) };
  });
}
