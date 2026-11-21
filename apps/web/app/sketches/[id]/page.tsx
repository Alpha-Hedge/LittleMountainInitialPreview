import SketchEditor from "@/components/sketch/SketchEditor";
import {redirect} from "next/navigation";
import WorkspaceShell from "@/components/WorkspaceShell";

export const metadata = {
  title: "Check the sketch | Little Mountain Metalworks",
};

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ read?: string | string[] }>;
};

export default async function SketchPage({ params, searchParams }: Props) {
  const [{ id }, { read }] = await Promise.all([params, searchParams]);
  const released=/^release-([a-f0-9-]{36})-v([1-9]\d*)$/.exec(id);
  if(released)redirect("/sketches/photo/"+released[1]+"?version="+released[2]);
  return (
    <WorkspaceShell
      active="sketches"
      breadcrumbs={[
        { label: "Sketch to drawing", href: "/sketches" },
        { label: "Check the sketch" },
      ]}
    >
      <SketchEditor id={id} readOnOpen={read === "1"} />
    </WorkspaceShell>
  );
}
