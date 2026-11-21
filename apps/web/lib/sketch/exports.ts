import { EngineeringInputError, runPython } from "../python-engine";
import { QuoteError } from "../quotes";
import type { SketchDraft } from "./types";

export interface ShopFiles {
  pdf: string;
  csv: string;
  dxfs: string[];
  partPages: number[];
}

async function compiler<T>(request: object): Promise<T> {
  try {
    return await runPython<T>("packages.cad.bridge", request);
  } catch (error) {
    if (error instanceof EngineeringInputError) throw new QuoteError(error.message, 422);
    throw error;
  }
}

export function compileShopFiles(draft: SketchDraft, revision: number) {
  return compiler<ShopFiles>({ draft, revision, format: "bundle" });
}

export function previewSketch(draft: SketchDraft) {
  return compiler({ draft, format: "preview" });
}
