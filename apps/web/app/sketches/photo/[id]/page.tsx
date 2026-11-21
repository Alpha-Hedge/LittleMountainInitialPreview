import WorkspaceShell from "@/components/WorkspaceShell";
import PhotoReview from "@/components/sketch/PhotoReview";

export const metadata = { title: "Review sketch | Little Mountain Metalworks" };

export default async function PhotoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const [{ id }, { version }] = await Promise.all([params, searchParams]);
  return (
    <WorkspaceShell
      active="sketches"
      breadcrumbs={[
        { label: "Sketch to drawing", href: "/sketches" },
        { label: "Review sketch" },
      ]}
    >
      <PhotoReview id={id} version={version} />
    </WorkspaceShell>
  );
}
