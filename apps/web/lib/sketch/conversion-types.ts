import type { Point, SketchDraft, SketchOutline } from "./types";
export type ReadingKind =
  | "width"
  | "height"
  | "radius"
  | "material"
  | "thickness"
  | "quantity"
  | "x"
  | "y"
  | "dx"
  | "dy"
  | "from_right"
  | "from_top"
  | "length"
  | "angle"
  | "center_x"
  | "center_y"
  | "hole_callout"
  | "diameter"
  | "slot_width"
  | "slot_length"
  | "slot_angle"
  | "bend_angle"
  | "bend_direction"
  | "weld"
  | "note"
  | "unsupported";
export interface Mark {
  kind: ReadingKind;
  targets: string[];
  value: string;
  evidence: string;
  confidence: number;
  at: Point;
}
export interface Question {
  text: string;
  at: Point;
}
interface Binding {
  candidate: string | null;
  confidence: number;
}
export interface PhotoPart extends Binding {
  part_id: string;
  name: string;
  shape: "rectangle" | "polygon" | "unknown";
  vertices: Point[];
  holes: (Binding & { shape: "round" | "slot" | "unknown"; at: Point })[];
  bends: (Binding & { start: Point; end: Point })[];
  annotations: Mark[];
  questions: Question[];
}
export interface PhotoReading {
  title: string;
  units: "in" | "mm" | null;
  unit_evidence: string;
  unit_confidence: number;
  parts: PhotoPart[];
  questions: Question[];
  dismissed: { ids: string[]; reason: string }[];
}
export interface Pin {
  code: string;
  target: string;
  part_id: string | null;
  annotation: number | null;
  field: ReadingKind | null;
  message: string;
  at: Point;
  review_key: string | null;
}
interface CadPart {
  name: string;
  material: string;
  quantity: number;
  thickness: number;
  notes: string;
  outline:
    | {
        kind: "rectangle";
        width: number;
        height: number;
        corner_radius: number;
      }
    | { kind: "polygon"; vertices: Point[] };
  holes: (
    | { shape: "round"; center: Point; diameter: number }
    | {
        shape: "slot";
        center: Point;
        width: number;
        length: number;
        angle: number;
      }
  )[];
  bends: {
    start: Point;
    end: Point;
    label: string;
    angle: number | null;
    direction: string | null;
  }[];
}
export interface CadDrawing {
  title: string;
  units: "mm" | "in";
  parts: CadPart[];
}
export type ConversionState =
  | "queued"
  | "reading"
  | "needs_review"
  | "released"
  | "failed";
export interface SketchSummary {
  drawing_id: string;
  filename: string;
  version: number;
  state: ConversionState;
  created_at: string;
}
export interface SketchConversion extends SketchSummary {
  sha256: string;
  mime: string;
  reading: PhotoReading | null;
  verified: string[];
  solution: {
    pins: Pin[];
    drawing: CadDrawing | null;
    snapped_edges: unknown[];
  } | null;
  evidence: {
    model?: string;
    registration?: { page_detected: boolean; size: [number, number] };
    candidates?: { id: string; kind: string; anchor: Point }[];
  };
  files: { name: string; mime: string; size: number; sha256: string }[];
  part_pages: number[];
  review_note: string;
  error: string | null;
  history: { version: number; state: ConversionState; note: string }[];
}
export const sketchStates: Record<ConversionState, string> = {
  queued: "Waiting to read",
  reading: "Checking drawing",
  needs_review: "Needs review",
  released: "Files ready",
  failed: "Needs attention",
};

export function toShopDraft(d: CadDrawing): SketchDraft {
  return {
    title: d.title,
    units: d.units,
    parts: d.parts.map((p) => {
      const outline: SketchOutline =
        p.outline.kind === "rectangle"
          ? {
              kind: "rectangle",
              width: p.outline.width,
              height: p.outline.height,
              cornerRadius: p.outline.corner_radius,
              vertices: [],
            }
          : {
              kind: "polygon",
              vertices: p.outline.vertices,
              width: null,
              height: null,
              cornerRadius: null,
            };
      return {
        name: p.name,
        material: p.material,
        quantity: p.quantity,
        thickness: p.thickness,
        notes: p.notes,
        outline,
        holes: p.holes.map((h) => ({
          shape: h.shape,
          centerX: h.center.x,
          centerY: h.center.y,
          diameter: h.shape === "round" ? h.diameter : null,
          width: h.shape === "slot" ? h.width : null,
          length: h.shape === "slot" ? h.length : null,
          angle: h.shape === "slot" ? h.angle : null,
        })),
        bendLines: p.bends.map((b) => ({
          start: b.start,
          end: b.end,
          label: [b.label, b.direction, b.angle === null ? "" : b.angle + "°"]
            .filter(Boolean)
            .join(" "),
        })),
      };
    }),
  };
}
