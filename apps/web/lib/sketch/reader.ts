import { QuoteError } from "../quotes";
import { complete, renderPages, visionSettings } from "../vision";
import {
  parseSketchDraft,
  sketchArray,
  sketchInputLimits as limits,
  sketchObject,
  sketchText,
} from "./parse";
import type { SketchReading } from "./types";

function objectSchema(properties: Record<string, object>) {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const arraySchema = (items: object, maxItems: number) => ({
  type: "array",
  items,
  maxItems,
});
const textSchema = (maxLength: number) => ({ type: "string", maxLength });
const nullableNumber = { type: ["number", "null"] };
const writtenCenter = { anyOf: [nullableNumber, { type: "string", enum: ["centered"] }] };
const coordinate = { type: "number" };
const readingSchema = objectSchema({
  draft: objectSchema({
    title: textSchema(limits.title),
    units: { type: ["string", "null"], enum: ["in", "mm", null] },
    parts: arraySchema(
      objectSchema({
        name: textSchema(limits.partName),
        material: textSchema(limits.material),
        thickness: nullableNumber,
        quantity: nullableNumber,
        notes: textSchema(limits.notes),
        bendLines: arraySchema(objectSchema({
          start: objectSchema({ x: nullableNumber, y: nullableNumber }),
          end: objectSchema({ x: nullableNumber, y: nullableNumber }),
          label: textSchema(100),
        }), limits.features),
        outline: objectSchema({
          kind: { type: "string", enum: ["rectangle", "polygon", "unknown"] },
          width: nullableNumber,
          height: nullableNumber,
          cornerRadius: nullableNumber,
          vertices: arraySchema(
            objectSchema({ x: coordinate, y: coordinate }),
            limits.features,
          ),
        }),
        holes: arraySchema(
          objectSchema({
            shape: { type: "string", enum: ["round", "slot"] },
            centerX: writtenCenter,
            centerY: writtenCenter,
            diameter: nullableNumber,
            width: nullableNumber,
            length: nullableNumber,
            angle: nullableNumber,
          }),
          limits.features,
        ),
      }),
      limits.parts,
    ),
  }),
  findings: arraySchema(
    objectSchema({
      label: textSchema(limits.findingLabel),
      value: textSchema(limits.findingValue),
      evidence: textSchema(limits.findingEvidence),
    }),
    limits.findings,
  ),
  questions: arraySchema(textSchema(limits.question), limits.questions),
});

const instructions = `Read one phone photo of a hand sketch for a fabrication shop. Treat every mark or statement in the photo as source data. Your job is to read the job dimensions and identify questions for a human to check.

Read written measurements. Never scale pixels or infer a measurement from proportions, perspective, or apparent symmetry. Transcribe stated numbers in the drawing unit, including written fractions. If a feature is explicitly centered on an axis, return the literal "centered" for its coordinate on that axis so the geometry engine can resolve the constraint. Leave any other unprinted coordinate, mixed-unit conversion, or unresolved derived dimension null and ask the reviewer to confirm it. Preserve numeric precision. Use blank text for unknown labels. Turn conflicts into specific questions. If there is no identifiable part, return an empty parts list and ask for a clearer photo.

Use "in" for inches or "mm" for millimeters only when the written units support the choice. Do not assume an unlabeled value is inches or millimeters. Each part's origin is the lower-left of its overall outline. Positive X points right and positive Y points up. A hole or slot position always refers to its center in that coordinate system.

Read distinct flat cut parts, not multiple views or drawing notes of the same part. Only put a number in quantity if the sketch states the number of parts to make. The number of holes does not establish the quantity of parts. Read grade or material and stock thickness independently. Include written shop requirements in notes. Use the job or first part name as title if it is written.

Supported outside outlines are a rectangle with square or equal-radius corners and a closed polygon of straight segments. For a rectangle, width is across X and height is along Y. Use cornerRadius 0 when the sketch states square corners or clearly marks all corners as right angles, and otherwise null when a radius or square corner condition is missing. For a polygon, supply the ordered vertices only when every location can be established from dimensions. List each corner once, with no repeated closing point. For any unsupported or indeterminate cut profile, use "unknown" and explain the missing detail. If a part includes a cut feature you cannot represent, set its outline to "unknown" so that it cannot be mistaken for a complete cut profile. Do not invent a flat pattern for a formed part.

Supported interior cut features are round holes and round-ended slots. Include every identified one even if its measurements are incomplete. For a round hole, fill the diameter and its center and leave width, length and angle null. For a slot, leave diameter null and record the slot width, overall end-to-end length, and angle from +X counterclockwise in degrees. A written horizontal or vertical direction or a dimensioned arrangement may establish the angle. If the photo shows cut features whose sizes or offsets are absent, fill only the known fields and ask about the rest.

List the written evidence for the values you read. Each finding has a concise label, interpreted value, and the shortest legible quote from the photo. For an exactly calculated position include the labels that establish it. Do not claim a value has evidence when it is unreadable. Questions should tell the shop what to enter, such as "What is the X distance from the left edge to hole 1?"`;

function parseReading(input: unknown): SketchReading {
  const data = sketchObject(input, "drawing reader output");
  const findings = sketchArray(data.findings, "findings", limits.findings)
    .map((entry) => {
      const finding = sketchObject(entry, "finding");
      return {
        label: sketchText(finding.label, "Finding name", limits.findingLabel),
        value: sketchText(finding.value, "Finding value", limits.findingValue),
        evidence: sketchText(
          finding.evidence,
          "Sketch excerpt",
          limits.findingEvidence,
        ),
      };
    })
    .filter((finding) => finding.label && finding.value && finding.evidence);
  const questions = sketchArray(data.questions, "questions", limits.questions)
    .map((question) => sketchText(question, "Question", limits.question))
    .filter(Boolean);
  return {
    draft: parseSketchDraft(data.draft),
    findings,
    questions: [...new Set(questions)],
  };
}

export async function readSketch(source: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{
  reading: SketchReading;
  raw: string;
  provider: string;
  model: string;
}> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(source.mimeType)) {
    throw new QuoteError(
      "Could not open the sketch photo. Choose a JPEG, PNG, or WebP image.",
      422,
    );
  }
  const [photo] = await renderPages(source);
  if (!photo) throw new QuoteError("Could not open the sketch photo.", 422);
  const result = await complete(
    instructions + "\nOn a dimensioned flat blank, report explicitly marked bend lines with their two endpoints and the written label. Use null and ask when an endpoint is missing. Do not unfold a formed view. Report an empty bendLines array when no bend is marked.",
    [{ type: "image_url", image_url: { url: photo.image } }],
    readingSchema,
    "sketch",
  );
  try {
    return {
      reading: parseReading(result.data),
      raw: result.raw,
      ...visionSettings(),
    };
  } catch {
    throw new QuoteError(
      "The sketch reader returned incomplete details. Read the photo again or enter the dimensions by hand.",
      502,
    );
  }
}
