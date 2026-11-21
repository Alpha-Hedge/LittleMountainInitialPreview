export type SketchUnit = "in" | "mm";
export type SketchPhotoMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/heic";

export interface Point {
  x: number;
  y: number;
}

export interface SketchOutline {
  kind: "rectangle" | "polygon" | "unknown";
  width: number | null;
  height: number | null;
  cornerRadius: number | null;
  vertices: Point[];
}

export interface SketchHole {
  shape: "round" | "slot";
  centerX: number | null;
  centerY: number | null;
  diameter: number | null;
  width: number | null;
  length: number | null;
  angle: number | null;
}

export interface SketchPart {
  bendLines?: { start: { x: number | null; y: number | null }; end: { x: number | null; y: number | null }; label: string }[];
  name: string;
  material: string;
  thickness: number | null;
  quantity: number | null;
  notes: string;
  outline: SketchOutline;
  holes: SketchHole[];
}

export interface SketchDraft {
  title: string;
  units: SketchUnit | null;
  parts: SketchPart[];
}

export interface SketchReading {
  draft: SketchDraft;
  findings: { label: string; value: string; evidence: string }[];
  questions: string[];
}

export interface SketchJob extends SketchReading {
  id: string;
  version: number;
  confirmed: boolean;
  fileName: string;
  mimeType: SketchPhotoMime;
  linkedQuoteId: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function blankPart(): SketchPart {
  return {
    name: "",
    material: "",
    thickness: null,
    quantity: null,
    notes: "",
    outline: {
      kind: "unknown",
      width: null,
      height: null,
      cornerRadius: null,
      vertices: [],
    },
    holes: [],
  };
}
