import { QuoteError } from "../quotes";
import type {
  SketchDraft,
  SketchHole,
  SketchOutline,
  SketchPart,
} from "./types";

export const sketchInputLimits = {
  parts: 20,
  features: 60,
  title: 120,
  partName: 100,
  material: 100,
  notes: 500,
  findings: 120,
  questions: 60,
  findingLabel: 100,
  findingValue: 150,
  findingEvidence: 200,
  question: 240,
} as const;

export function sketchObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QuoteError("Check the " + label + ".");
  }
  return value as Record<string, unknown>;
}

export function sketchText(
  value: unknown,
  label: string,
  limit: number,
): string {
  if (typeof value !== "string" || value.length > limit) {
    throw new QuoteError(label + " must be " + limit + " characters or fewer.");
  }
  return value.trim();
}

export function sketchArray(
  value: unknown,
  label: string,
  limit: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new QuoteError("Use up to " + limit + " " + label + ".");
  }
  return value;
}

function dimension(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QuoteError("Enter a number for " + label + ".");
  }
  return value;
}

function numberOrBlank(value: unknown, label: string): number | null {
  return value === null ? null : dimension(value, label);
}

function outline(input: unknown, label: string): SketchOutline {
  const value = sketchObject(input, label + " outline");
  const kind = value.kind;
  if (kind !== "rectangle" && kind !== "polygon" && kind !== "unknown") {
    throw new QuoteError("Pick an outline for " + label + ".");
  }
  return {
    kind,
    width: numberOrBlank(value.width, label + " width"),
    height: numberOrBlank(value.height, label + " height"),
    cornerRadius: numberOrBlank(value.cornerRadius, label + " corner radius"),
    vertices: sketchArray(
      value.vertices,
      "corners per part",
      sketchInputLimits.features,
    ).map((entry, index) => {
      const pointLabel = label + ", corner " + (index + 1);
      const point = sketchObject(entry, pointLabel);
      return {
        x: dimension(point.x, pointLabel + " X"),
        y: dimension(point.y, pointLabel + " Y"),
      };
    }),
  };
}

function holes(input: unknown, partLabel: string): SketchHole[] {
  return sketchArray(
    input,
    "holes or slots per part",
    sketchInputLimits.features,
  ).map((entry, index) => {
    const label = partLabel + ", hole or slot " + (index + 1);
    const value = sketchObject(entry, label);
    const shape = value.shape;
    if (shape !== "round" && shape !== "slot")
      throw new QuoteError("Choose round hole or slot for " + label + ".");
    return {
      shape,
      centerX: numberOrBlank(value.centerX, label + " center X"),
      centerY: numberOrBlank(value.centerY, label + " center Y"),
      diameter: numberOrBlank(value.diameter, label + " diameter"),
      width: numberOrBlank(value.width, label + " width"),
      length: numberOrBlank(value.length, label + " overall length"),
      angle: numberOrBlank(value.angle, label + " angle"),
    };
  });
}

function part(input: unknown, index: number): SketchPart {
  const label = "Part " + (index + 1);
  const value = sketchObject(input, label);
  return {
    name: sketchText(value.name, label + " name", sketchInputLimits.partName),
    material: sketchText(
      value.material,
      label + " material",
      sketchInputLimits.material,
    ),
    thickness: numberOrBlank(value.thickness, label + " thickness"),
    quantity: numberOrBlank(value.quantity, label + " quantity"),
    notes: sketchText(value.notes, label + " notes", sketchInputLimits.notes),
    outline: outline(value.outline, label),
    holes: holes(value.holes, label),
    ...(value.bendLines === undefined ? {} : {
      bendLines: sketchArray(value.bendLines, "bend lines", sketchInputLimits.features).map((entry) => {
        const bend = sketchObject(entry, "bend line");
        const point = (raw: unknown) => {
          const p = sketchObject(raw, "bend endpoint");
          return { x: numberOrBlank(p.x, "bend X"), y: numberOrBlank(p.y, "bend Y") };
        };
        return { start: point(bend.start), end: point(bend.end), label: sketchText(bend.label, "bend label", 100) };
      }),
    }),
  };
}

export function parseSketchDraft(input: unknown): SketchDraft {
  const value = sketchObject(input, "sketch details");
  const units = value.units;
  if (units !== "in" && units !== "mm" && units !== null) {
    throw new QuoteError("Choose inches or millimeters.");
  }
  return {
    title: sketchText(value.title, "Drawing name", sketchInputLimits.title),
    units,
    parts: sketchArray(
      value.parts,
      "parts per sketch",
      sketchInputLimits.parts,
    ).map(part),
  };
}
