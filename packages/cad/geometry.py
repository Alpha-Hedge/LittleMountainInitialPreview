"""Analytic line/arc cut paths. Shapely validates topology in drawing units."""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations, pairwise
from math import atan, atan2, ceil, cos, dist, hypot, pi, radians, sin, tan

from shapely.geometry import LineString, Point, Polygon, box
from shapely.strtree import STRtree
from shapely.validation import explain_validity

from .schema import BendLine, Part, PolygonOutline, Rectangle, RoundHole, Slot

Vertex = tuple[float, float, float]  # x, y, outgoing DXF bulge
Loop = list[Vertex]
EPS = 1e-8


@dataclass
class DraftProfile:
    """Incomplete shop drawings use validated geometry without invented stock metadata."""

    outline: Rectangle | PolygonOutline
    holes: list[RoundHole | Slot] = field(default_factory=list)
    bends: list[BendLine] = field(default_factory=list)
    dimensions: tuple = ()
    notes: str = ""


def edges(loop):
    return pairwise([*loop, loop[0]])


def rounded_rectangle(x0, y0, width, height, radius) -> Loop:
    x1, y1 = x0 + width, y0 + height
    if not radius:
        return [(x0, y0, 0), (x1, y0, 0), (x1, y1, 0), (x0, y1, 0)]
    b = tan(pi / 8)
    vertices = [
        (x0 + radius, y0, 0),
        (x1 - radius, y0, b),
        (x1, y0 + radius, 0),
        (x1, y1 - radius, b),
        (x1 - radius, y1, 0),
        (x0 + radius, y1, b),
        (x0, y1 - radius, 0),
        (x0, y0 + radius, b),
    ]
    return [v for v, following in edges(vertices) if v[:2] != following[:2]]


def arc_data(first, second):
    x, y, bulge = first
    dx, dy = second[0] - x, second[1] - y
    sweep = 4 * atan(bulge)
    shift = (1 - bulge * bulge) / (4 * bulge)
    cx, cy = x + dx / 2 - dy * shift, y + dy / 2 + dx * shift
    return cx, cy, hypot(cx - x, cy - y), atan2(y - cy, x - cx), sweep


def sampled(loop: Loop):
    """For planar visual/topology checks only. DXF always retains the analytic arcs."""
    result = []
    for first, second in edges(loop):
        result.append(first[:2])
        if first[2]:
            cx, cy, radius, angle, sweep = arc_data(first, second)
            steps = max(2, ceil(abs(sweep) / (pi / 90)))
            for index in range(1, steps):
                theta = angle + sweep * index / steps
                result.append((cx + radius * cos(theta), cy + radius * sin(theta)))
    return result


def metrics(loop):
    # Integrate line and circular-segment contributions relative to the first vertex.
    ox, oy = loop[0][:2]
    area, length = 0.0, 0.0
    for a, b in edges(loop):
        area += ((a[0] - ox) * (b[1] - oy) - (a[1] - oy) * (b[0] - ox)) / 2
        if a[2]:
            _, _, radius, _, theta = arc_data(a, b)
            area += radius**2 * (theta - sin(theta)) / 2
            length += radius * abs(theta)
        else:
            length += dist(a[:2], b[:2])
    return abs(area), length


@dataclass
class Opening:
    axis: Point | LineString
    radius: float
    loop: Loop


def opening(hole, offset=0.0):
    x, y = hole.center.xy
    if isinstance(hole, RoundHole):
        radius = hole.diameter / 2 - offset
        if radius <= EPS:
            raise ValueError("Kerf closes a round hole. Select a narrower process.")
        return Opening(Point(x, y), radius, [(x + radius, y, -1), (x - radius, y, -1)])
    radius = hole.width / 2 - offset
    if radius <= EPS:
        raise ValueError("Kerf closes a slot. Select a narrower process.")
    angle = radians(hole.angle % 360)
    ux, uy = cos(angle), sin(angle)
    run = (hole.length - hole.width) / 2
    a, b = (x - ux * run, y - uy * run), (x + ux * run, y + uy * run)
    nx, ny = -uy * radius, ux * radius
    loop = [
        (a[0] + nx, a[1] + ny, 0),
        (b[0] + nx, b[1] + ny, -1),
        (b[0] - nx, b[1] - ny, 0),
        (a[0] - nx, a[1] - ny, -1),
    ]
    return Opening(LineString([a, b]), radius, loop)


def outer_loop(part: Part | DraftProfile, offset=0.0):
    outline = part.outline
    if isinstance(outline, Rectangle):
        return rounded_rectangle(
            -offset,
            -offset,
            outline.width + 2 * offset,
            outline.height + 2 * offset,
            outline.corner_radius + offset,
        )
    vertices = [p.xy for p in outline.vertices]
    if vertices[0] == vertices[-1]:
        vertices.pop()
    if (
        len(set(vertices)) != len(vertices)
        or len(vertices) < 3
        or any(dist(a, b) <= EPS for a, b in edges(vertices))
    ):
        raise ValueError("Remove duplicate polygon vertices or zero-length edges.")
    polygon = Polygon(vertices)
    if not polygon.is_valid or polygon.area <= EPS**2:
        raise ValueError(f"Invalid outer profile: {explain_validity(polygon)}")
    if not polygon.exterior.is_ccw:
        vertices.reverse()
    if offset:
        return polygon_offset(vertices, offset, polygon)
    return [(x, y, 0.0) for x, y in vertices]


def polygon_offset(points, amount, nominal):
    """External offset with exact lines and radius arcs. Reject collapsed features."""
    if not nominal.equals(nominal.convex_hull):
        segments = [LineString([a, b]) for a, b in edges(points)]
        # Every exact offset line/arc lies within a tool radius of its source edge.
        # Separate non-neighboring edge neighborhoods before using any tessellation.
        tree = STRtree(segments)
        indices = tree.query(segments, predicate="dwithin", distance=2 * amount + EPS)
        if any(1 < j - i < len(points) - 1 for i, j in zip(*indices, strict=True)):
            raise ValueError("Kerf offset approaches a nonadjacent polygon edge. Reduce the kerf.")
    joins = []
    for i, p in enumerate(points):
        a, b = points[i - 1], points[(i + 1) % len(points)]
        before, after = dist(a, p), dist(p, b)
        if min(before, after) <= EPS:
            raise ValueError("Polygon kerf offset has an unresolved short edge.")
        u = ((p[0] - a[0]) / before, (p[1] - a[1]) / before)
        v = ((b[0] - p[0]) / after, (b[1] - p[1]) / after)
        cross, dot = u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]
        angle = atan2(cross, dot)
        if angle > 1e-10:
            joins.append(
                [
                    (p[0] + u[1] * amount, p[1] - u[0] * amount, tan(angle / 4)),
                    (p[0] + v[1] * amount, p[1] - v[0] * amount, 0),
                ]
            )
        elif 1 + dot > 1e-10:
            d = amount / (1 + dot)
            joins.append([(p[0] + (u[1] + v[1]) * d, p[1] - (u[0] + v[0]) * d, 0)])
        else:
            raise ValueError("Kerf offset collapses a narrow polygon corner.")
    for (p, q), (start, end) in zip(edges(points), edges(joins), strict=True):
        dx, dy = q[0] - p[0], q[1] - p[1]
        length = hypot(dx, dy)
        a, b = start[-1], end[0]
        begin = ((a[0] - p[0]) * dx + (a[1] - p[1]) * dy) / length
        finish = ((b[0] - p[0]) * dx + (b[1] - p[1]) * dy) / length
        if begin < -EPS or finish > length + EPS or finish - begin <= EPS:
            raise ValueError("Kerf offset trims away a polygon edge. Reduce the kerf.")
    result = [vertex for join in joins for vertex in join]
    shape = Polygon(sampled(result))
    reference = nominal.buffer(amount, quad_segs=45)
    # Check the analytic offset against GEOS' independent disk offset. Both planar
    # audit representations sample arcs at maximum 2 degrees, with sagitta < 0.00016r.
    if (
        not shape.is_valid
        or not shape.covers(nominal)
        or len(reference.interiors)
        or shape.boundary.hausdorff_distance(reference.boundary) > amount * 0.0004 + EPS
    ):
        raise ValueError("Kerf offset crosses or erases a polygon feature. Reduce the kerf.")
    return result


def rounded_distance(outline: Rectangle, point):
    """Signed Euclidean distance to the rounded rectangle; negative is inside."""
    r = outline.corner_radius
    dx = abs(point[0] - outline.width / 2) - (outline.width / 2 - r)
    dy = abs(point[1] - outline.height / 2) - (outline.height / 2 - r)
    return hypot(max(0, dx), max(0, dy)) + min(max(dx, dy), 0) - r


@dataclass
class Geometry:
    part: Part | DraftProfile
    outer: Loop
    inner: list[Opening]
    bounds: tuple[float, float, float, float]
    net_area: float
    cut_length: float


def solve_part(part: Part | DraftProfile) -> Geometry:
    outer = outer_loop(part)
    planar = Polygon(sampled(outer))
    if not planar.is_valid:
        raise ValueError(f"Invalid outer profile: {explain_validity(planar)}")
    holes = [opening(hole) for hole in part.holes]
    for i, h in enumerate(holes, 1):
        # The segment swept by a disk gives a capsule exactly. This avoids tessellation
        # tolerances masking tangencies between holes or between holes and curves.
        if isinstance(part.outline, Rectangle):
            fits = all(rounded_distance(part.outline, p) < -h.radius - EPS for p in h.axis.coords)
        else:
            fits = planar.contains(h.axis) and planar.boundary.distance(h.axis) > h.radius + EPS
        if not fits:
            raise ValueError(f"Opening {i} must sit fully inside the outer profile.")
    for a, b in combinations(holes, 2):
        if a.axis.distance(b.axis) <= a.radius + b.radius + EPS:
            raise ValueError("Cut openings touch or overlap.")
    section = Polygon(sampled(outer), [sampled(h.loop) for h in holes])
    # For nearly tangent holes, the inscribed polygon used only for this additional
    # check may conservatively reject a curved outside edge.
    if not section.is_valid:
        raise ValueError(f"Invalid planar topology: {explain_validity(section)}")
    lines = []
    for i, bend in enumerate(part.bends, 1):
        line = LineString([bend.start.xy, bend.end.xy])
        if line.length <= EPS:
            raise ValueError(f"Bend {i} must have distinct endpoints.")
        if isinstance(part.outline, Rectangle):
            inside = all(rounded_distance(part.outline, p) <= EPS for p in line.coords)
        else:
            inside = planar.covers(line)
        if (
            not inside
            or planar.boundary.intersection(line).length > EPS
            or any(line.distance(h.axis) <= h.radius + EPS for h in holes)
        ):
            raise ValueError(f"Bend {i} must lie across solid material.")
        if any(line.intersection(other).length > EPS for other in lines):
            raise ValueError(f"Bend {i} overlaps another scribe path.")
        lines.append(line)
    xmin, ymin, xmax, ymax = planar.bounds
    reference_box = box(xmin, ymin, xmax, ymax).buffer(EPS)
    for dimension in part.dimensions:
        if not all(reference_box.covers(Point(p.xy)) for p in (dimension.start, dimension.end)):
            raise ValueError(f"{dimension.label} references coordinates outside the blank.")
    area, length = metrics(outer)
    for h in holes:
        removed, cut = metrics(h.loop)
        area -= removed
        length += cut
    return Geometry(part, outer, holes, (xmin, ymin, xmax, ymax), area, length)
