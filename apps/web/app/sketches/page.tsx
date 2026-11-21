import SketchList from "@/components/sketch/SketchList";
import WorkspaceShell from "@/components/WorkspaceShell";
import { engineeringConnection } from "@/lib/engineering-connection";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sketch to drawing | Little Mountain Metalworks",
};

export default function SketchesPage() {
  return (
    <WorkspaceShell
      active="sketches"
      breadcrumbs={[{ label: "Sketch to drawing" }]}
    >
      <SketchList engineering={Boolean(engineeringConnection())} />
    </WorkspaceShell>
  );
}
