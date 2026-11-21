import { notFound } from "next/navigation";
import { blueprintOrigin } from "@/lib/engineering-ledger";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import { BlueprintEstimate } from "@/app/blueprints/workspace";
import "@/app/blueprints/blueprints.css";

export const dynamic = "force-dynamic";
export default async function SourceEstimate({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    record = blueprintOrigin(id);
  if (!record) notFound();
  return (
    <WorkspaceShell
      active="quotes"
      breadcrumbs={[
        { label: "Quote draft", href: "/quotes/" + id },
        { label: "Original blueprint estimate" },
      ]}
    >
      <BlueprintEstimate id={record.job.id} frozen={record.job} />
    </WorkspaceShell>
  );
}
