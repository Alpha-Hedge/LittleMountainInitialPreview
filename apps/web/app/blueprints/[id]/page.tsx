import { WorkspaceShell } from "@/components/WorkspaceShell";
import { BlueprintEstimate } from "../workspace";
import "../blueprints.css";

export default async function EstimatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <WorkspaceShell
      active="blueprints"
      breadcrumbs={[
        { label: "Drawing reviews", href: "/blueprints" },
        { label: "Estimate" },
      ]}
    >
      <BlueprintEstimate id={id} />
    </WorkspaceShell>
  );
}
