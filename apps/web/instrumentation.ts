import { isHostedPreview } from "./lib/hosted-preview";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build" && !isHostedPreview()) {
    const { startLearningSync } = await import("./lib/cloud-history");
    startLearningSync();
    const { startEngineeringArchive } = await import("./lib/engineering-archive");
    startEngineeringArchive();
  }
}
