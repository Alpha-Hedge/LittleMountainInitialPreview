import type { Point, SketchDraft, SketchPart } from "./types";
export type ProfileVertex = Point & { bulge: number };
export type ProfileContour =
  | { kind: "polyline"; vertices: ProfileVertex[] }
  | { kind: "circle"; center: Point; radius: number };
type Capsule = { start: Point; end: Point; radius: number };
type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

const epsilon = 1e-8;
const maxDimension = 1_000_000;

function supportedNumber(value: number | null): value is number {
  return (
    value !== null && Number.isFinite(value) && Math.abs(value) <= maxDimension
  );
}

function size(value: number | null): value is number {
  return supportedNumber(value) && value > epsilon;
}

function delta(a: Point, b: Point): Point {
  return { x: b.x - a.x, y: b.y - a.y };
}

function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y;
}

function norm(value: Point) {
  return Math.hypot(value.x, value.y);
}

function coincident(a: Point, b: Point) {
  return norm(delta(a, b)) <= epsilon;
}

function pointToSegment(point: Point, a: Point, b: Point) {
  const edge = delta(a, b);
  const fromA = delta(a, point);
  const squaredLength = dot(edge, edge);
  const along =
    squaredLength > 0
      ? Math.min(1, Math.max(0, dot(edge, fromA) / squaredLength))
      : 0;
  return Math.hypot(fromA.x - edge.x * along, fromA.y - edge.y * along);
}

function orientation(a: Point, b: Point, p: Point) {
  const edge = delta(a, b);
  const fromA = delta(a, p);
  const cross = edge.x * fromA.y - edge.y * fromA.x;
  return Math.abs(cross) <= epsilon * norm(edge) ? 0 : Math.sign(cross);
}

function segmentsTouch(a: Point, b: Point, c: Point, d: Point) {
  if (coincident(a, b)) return pointToSegment(a, c, d) <= epsilon;
  if (coincident(c, d)) return pointToSegment(c, a, b) <= epsilon;
  if (
    orientation(a, b, c) * orientation(a, b, d) < 0 &&
    orientation(c, d, a) * orientation(c, d, b) < 0
  )
    return true;
  return proximity(a, b, c, d) <= epsilon;
}

function proximity(a: Point, b: Point, c: Point, d: Point) {
  return Math.min(
    pointToSegment(a, c, d),
    pointToSegment(b, c, d),
    pointToSegment(c, a, b),
    pointToSegment(d, a, b),
  );
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
  return segmentsTouch(a, b, c, d) ? 0 : proximity(a, b, c, d);
}

function polygonVertices(part: SketchPart): Point[] {
  const vertices = part.outline.vertices;
  return vertices.length >= 2 &&
    coincident(vertices[0], vertices[vertices.length - 1])
    ? vertices.slice(0, -1)
    : vertices;
}

function polygonEdges(vertices: Point[]): [Point, Point][] {
  return vertices.map((point, index) => [
    point,
    vertices[(index + 1) % vertices.length],
  ]);
}

function pointInPolygon(point: Point, edges: [Point, Point][]) {
  let inside = false;
  for (const [a, b] of edges) {
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y)
    )
      inside = !inside;
  }
  return inside;
}

function outlineIssue(part: SketchPart): string | null {
  const { kind, width, height, cornerRadius } = part.outline;
  if (kind === "unknown") return "Choose an outline and enter its dimensions.";
  if (kind === "rectangle") {
    if (!size(width) || !size(height))
      return "Enter a positive width and height.";
    if (
      !supportedNumber(cornerRadius) ||
      cornerRadius < 0 ||
      (cornerRadius > 0 && cornerRadius <= epsilon) ||
      cornerRadius > Math.min(width, height) / 2
    ) {
      return "Enter 0 for square corners or a radius up to half the shorter edge.";
    }
    return null;
  }
  const vertices = polygonVertices(part);
  if (
    vertices.length < 3 ||
    vertices.some(({ x, y }) => !supportedNumber(x) || !supportedNumber(y))
  ) {
    return "Enter at least three outline points with an X and Y position.";
  }
  const edges = polygonEdges(vertices);
  if (edges.some(([a, b]) => coincident(a, b)))
    return "Remove repeated points from the outline.";
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i];
    const c = edges[(i + 1) % edges.length][1];
    if (!orientation(a, b, c) && dot(delta(a, b), delta(b, c)) < 0) {
      return "Order the outline points around the edge without doubling back.";
    }
    for (let j = i + 2; j < edges.length; j++) {
      if (i === 0 && j === edges.length - 1) continue;
      if (segmentsTouch(a, b, ...edges[j]))
        return "Order the outline points so the edges do not cross or touch.";
    }
  }
  const origin = vertices[0];
  const doubleArea = edges.reduce((sum, [a, b]) => {
    const pa = delta(origin, a);
    const pb = delta(origin, b);
    return sum + pa.x * pb.y - pa.y * pb.x;
  }, 0);
  if (Math.abs(doubleArea) <= epsilon ** 2)
    return "Enter outline points that enclose an area.";
  return null;
}

export function partBounds(part: SketchPart): Bounds | null {
  if (outlineIssue(part)) return null;
  if (part.outline.kind === "rectangle") {
    const { width, height } = part.outline;
    return {
      minX: 0,
      minY: 0,
      maxX: width!,
      maxY: height!,
      width: width!,
      height: height!,
    };
  }
  const vertices = polygonVertices(part);
  const minX = Math.min(...vertices.map((point) => point.x));
  const minY = Math.min(...vertices.map((point) => point.y));
  const maxX = Math.max(...vertices.map((point) => point.x));
  const maxY = Math.max(...vertices.map((point) => point.y));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function toCapsule(hole: SketchPart["holes"][number]): Capsule | null {
  const { centerX, centerY, diameter, width, length, angle } = hole;
  if (!supportedNumber(centerX) || !supportedNumber(centerY)) return null;
  const center = { x: centerX, y: centerY };
  if (hole.shape === "round") {
    return size(diameter)
      ? { start: center, end: center, radius: diameter / 2 }
      : null;
  }
  if (
    !size(width) ||
    !size(length) ||
    length <= width + epsilon ||
    !supportedNumber(angle)
  )
    return null;
  const radians = ((angle % 360) * Math.PI) / 180;
  const halfRun = (length - width) / 2;
  const x = Math.cos(radians) * halfRun;
  const y = Math.sin(radians) * halfRun;
  return {
    start: { x: centerX - x, y: centerY - y },
    end: { x: centerX + x, y: centerY + y },
    radius: width / 2,
  };
}

function fitsOutline(part: SketchPart, capsule: Capsule) {
  const { start, end, radius } = capsule;
  const { width, height, cornerRadius } = part.outline;
  if (part.outline.kind === "rectangle") {
    // A rounded rectangle is convex. If both endpoints of the eroded outline
    // contain the slot centers, the whole capsule lies inside the cut profile.
    return [start, end].every(({ x, y }) => {
      const dx = Math.abs(x - width! / 2) - (width! / 2 - cornerRadius!);
      const dy = Math.abs(y - height! / 2) - (height! / 2 - cornerRadius!);
      const signedDistance =
        Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) +
        Math.min(Math.max(dx, dy), 0) -
        cornerRadius!;
      return signedDistance < -radius - epsilon;
    });
  }
  const edges = polygonEdges(polygonVertices(part));
  return (
    pointInPolygon(start, edges) &&
    pointInPolygon(end, edges) &&
    edges.every(
      ([a, b]) => segmentDistance(start, end, a, b) > radius + epsilon,
    )
  );
}

export function drawingIssues(draft: SketchDraft): string[] {
  const issues: string[] = [];
  if (!draft.title.trim()) issues.push("Enter a job name.");
  if (draft.units !== "in" && draft.units !== "mm")
    issues.push("Choose inches or millimeters.");
  if (!draft.parts.length) issues.push("Add at least one part.");
  draft.parts.forEach((part, index) => {
    const name = part.name.trim();
    const label = name ? `Part ${index + 1} (${name})` : `Part ${index + 1}`;
    if (!name) issues.push(`${label} — enter the part name.`);
    if (!part.material.trim()) issues.push(`${label} — enter the material.`);
    if (!size(part.thickness))
      issues.push(`${label} — enter a positive thickness.`);
    if (
      part.quantity === null ||
      !Number.isSafeInteger(part.quantity) ||
      part.quantity < 1 ||
      part.quantity > 1_000_000_000
    ) {
      issues.push(`${label} — enter the number of pieces to cut.`);
    }
    const issue = outlineIssue(part);
    if (issue) issues.push(`${label} — ${issue}`);
    const previous: { id: number; capsule: Capsule }[] = [];
    for (const [index, bend] of (part.bendLines ?? []).entries()) {
      const { start, end } = bend;
      if ([start.x, start.y, end.x, end.y].some(v => v === null || !Number.isFinite(v)) ||
          (start.x === end.x && start.y === end.y))
        issues.push(`${label} — enter two distinct endpoints for bend ${index + 1}.`);
    }
    part.holes.forEach((hole, holeIndex) => {
      const id = holeIndex + 1;
      const capsule = toCapsule(hole);
      if (!capsule) {
        const details =
          hole.shape === "round"
            ? "the center and a positive diameter"
            : "the center, angle, and a length greater than the width";
        issues.push(`${label} — opening ${id} needs ${details}.`);
        return;
      }
      if (!issue && !fitsOutline(part, capsule)) {
        issues.push(
          `${label} — opening ${id} must sit fully inside the outline with space around it.`,
        );
      }
      const overlap = previous.find(
        ({ capsule: other }) =>
          segmentDistance(capsule.start, capsule.end, other.start, other.end) <=
          capsule.radius + other.radius + epsilon,
      );
      if (overlap)
        issues.push(
          `${label} — openings ${overlap.id} and ${id} touch or overlap.`,
        );
      previous.push({ id, capsule });
    });
  });
  return issues;
}

export function partContours(part: SketchPart): ProfileContour[] {
  if (outlineIssue(part)) return [];
  const { kind, width, height, cornerRadius } = part.outline;
  let vertices: ProfileVertex[];
  if (kind === "polygon") {
    vertices = polygonVertices(part).map((point) => ({ ...point, bulge: 0 }));
  } else {
    const w = width!,
      h = height!,
      r = cornerRadius!;
    const quarterArc = Math.tan(Math.PI / 8);
    vertices = (
      r === 0
        ? [
            [0, 0, 0],
            [w, 0, 0],
            [w, h, 0],
            [0, h, 0],
          ]
        : [
            [r, 0, 0],
            [w - r, 0, quarterArc],
            [w, r, 0],
            [w, h - r, quarterArc],
            [w - r, h, 0],
            [r, h, quarterArc],
            [0, h - r, 0],
            [0, r, quarterArc],
          ]
    )
      .map(([x, y, bulge]) => ({ x, y, bulge }))
      .filter(
        (vertex, index, all) =>
          !coincident(vertex, all[(index + 1) % all.length]),
      );
  }

  const contours: ProfileContour[] = [{ kind: "polyline", vertices }];
  for (const hole of part.holes) {
    const capsule = toCapsule(hole);
    if (!capsule) continue;
    const { start, end, radius } = capsule;
    if (hole.shape === "round") {
      contours.push({ kind: "circle", center: start, radius });
      continue;
    }
    const radians = ((hole.angle! % 360) * Math.PI) / 180;
    const x = -Math.sin(radians) * radius;
    const y = Math.cos(radians) * radius;
    contours.push({
      kind: "polyline",
      vertices: [
        { x: start.x - x, y: start.y - y, bulge: 0 },
        { x: end.x - x, y: end.y - y, bulge: 1 },
        { x: end.x + x, y: end.y + y, bulge: 0 },
        { x: start.x + x, y: start.y + y, bulge: 1 },
      ],
    });
  }
  return contours;
}

export function polylinePath(vertices: ProfileVertex[]): string {
  if (!vertices.length) return "";
  const first = vertices[0];
  const segments = vertices.map((point, i) => {
    const next = vertices[(i + 1) % vertices.length];
    if (!point.bulge) return `L ${next.x} ${next.y}`;
    const angle = 4 * Math.atan(point.bulge);
    const radius =
      norm(delta(point, next)) / (2 * Math.sin(Math.abs(angle) / 2));
    return `A ${radius} ${radius} 0 ${Math.abs(angle) > Math.PI ? 1 : 0} ${angle > 0 ? 1 : 0} ${next.x} ${next.y}`;
  });
  return `M ${first.x} ${first.y} ${segments.join(" ")} Z`;
}
