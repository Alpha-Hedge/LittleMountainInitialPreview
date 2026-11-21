import "./test-typescript.mjs";
const { cloudConfigured, cloudStatus, syncLearningHistory } = await import("../apps/web/lib/cloud-history.ts");
const { getLearningWorkspaceId, requestLearningBackfill } = await import("../apps/web/lib/learning-export.ts");

if (!cloudConfigured())
  throw new Error("Set the two server-side Supabase URLs for this data directory.");
if (process.argv.includes("--backfill")) requestLearningBackfill();
await syncLearningHistory();
const status = await cloudStatus();
if (!status.reachable || status.error) throw new Error(status.error || "Could not verify the database.");
console.log("Workspace", getLearningWorkspaceId());
console.log(
  status.entities,
  "synced quote/settings records;",
  status.lines,
  "approved lines;",
  status.pending,
  "pending.",
);
