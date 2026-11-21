import { WorkspaceShell } from "@/components/WorkspaceShell";
import { BlueprintDesk } from "./workspace";
import "./blueprints.css";

export default function BlueprintPage() {
  return (
    <WorkspaceShell
      active="blueprints"
      breadcrumbs={[{ label: "Drawing reviews" }]}
    >
      <BlueprintDesk />
    </WorkspaceShell>
  );
}
