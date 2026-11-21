import { notFound } from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";
import JobActuals from "@/components/JobActuals";
import { getApprovalSnapshot } from "@/lib/workflow";
import { getJob } from "@/lib/jobs";
import "@/app/workspace-pages.css";
import "@/app/job-history.css";
import "@/app/jobs/finished.css";
export const dynamic = "force-dynamic";
export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; version: string }>;
  searchParams: Promise<{ edit?: string | string[] }>;
}) {
  const { id, version } = await params;
  const { edit: rawEdit } = await searchParams;
  const edit = rawEdit === undefined ? undefined : Number(rawEdit);
  if (
    edit !== undefined &&
    (typeof rawEdit !== "string" || !/^\d+$/.test(rawEdit) || !Number.isSafeInteger(edit) || edit < 1)
  )
    notFound();
  const a = getApprovalSnapshot(id, Number(version));
  if (!a) notFound();
  const saved = getJob(id, a.quote.version, edit);
  if (edit !== undefined && !saved) notFound();
  return (
    <WorkspaceShell
      active="jobs"
      breadcrumbs={[
        { label: "Finished work", href: "/jobs" },
        { label: a.quote.number + " · v" + a.quote.version },
      ]}
    >
      <JobActuals key={edit ?? "current"} quote={a.quote} saved={saved} readOnly={edit !== undefined} />
    </WorkspaceShell>
  );
}
