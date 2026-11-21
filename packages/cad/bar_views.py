"""Orthographic review views for the flat bars shown in an assembly sketch."""

from math import hypot

import cv2
import numpy as np
from reportlab.lib.colors import black
from reportlab.lib.utils import simpleSplit
from shapely.geometry import Point, Polygon

from .shop_sheet import fit, write


def broad_face(member):
    return max((Polygon([(p.x, p.y) for p in face.corners]) for face in member.faces),
               key=lambda face: face.area)


def _bar_projection(face, plate):
    if not face.is_valid or face.area <= 0:
        return None
    corners = list(face.exterior.coords)[:-1]
    if len(corners) != 4 or face.area < face.convex_hull.area * .99:
        return None
    vectors = [(b[0] - a[0], b[1] - a[1]) for a, b in zip(corners, corners[1:] + corners[:1])]
    lengths = [hypot(*v) for v in vectors]
    side = int(lengths[1] + lengths[3] < lengths[0] + lengths[2])
    ends = (side, side + 2)
    start = max(ends, key=lambda i: plate.distance(Point(
        (corners[i][0] + corners[(i + 1) % 4][0]) / 2,
        (corners[i][1] + corners[(i + 1) % 4][1]) / 2,
    )))
    # The free end is at X=0 and the end next to the plate is at X=1.
    source = np.float32(corners[start:] + corners[:start])
    target = np.float32([(0, 0), (0, 1), (1, 1), (1, 0)])
    projection = cv2.getPerspectiveTransform(source, target)
    return projection if abs(np.linalg.det(projection)) > 1e-12 else None


def pictured_rods(assembly, bars):
    """Project the visible rods onto their own bar faces for the schematic only."""
    plate = broad_face(next(member for member in assembly.members if member.kind == "plate"))
    faces = [broad_face(member) for member in bars]
    transforms = [_bar_projection(face, plate) for face in faces]
    positions = [set() for _ in bars]
    for group in assembly.hardware:
        if group.kind != "rod":
            continue
        for mark in group.marks:
            point = Point(mark.at.x, mark.at.y)
            order = sorted(range(len(faces)), key=lambda i: faces[i].distance(point))
            index = order[0]
            # An ambiguous overlapping face doesn't get a rod symbol.
            if faces[index].distance(point) == faces[order[1]].distance(point) or transforms[index] is None:
                continue
            location = np.float32([[[point.x, point.y]]])
            along, across = map(float, cv2.perspectiveTransform(location, transforms[index])[0, 0])
            if 0 <= along <= 1 and -.22 <= across <= 1.22:
                positions[index].add((round(along, 4), round(min(.82, max(.18, across)), 4)))
    return tuple(tuple(sorted(row)) for row in positions)


def _arrow(c, x, y, dx, dy):
    arrow = c.beginPath()
    arrow.moveTo(x, y)
    arrow.lineTo(x + dx - dy * .35, y + dy + dx * .35)
    arrow.lineTo(x + dx + dy * .35, y + dy - dx * .35)
    arrow.close()
    c.setFillColor(black)
    c.drawPath(arrow, stroke=0, fill=1)


def _horizontal_dimension(c, left, right, baseline, origin, text):
    c.setStrokeColor(black)
    c.setLineWidth(.55)
    c.lines([(left, origin, left, baseline + 4), (right, origin, right, baseline + 4),
             (left, baseline, right, baseline)])
    _arrow(c, left, baseline, 6, 0)
    _arrow(c, right, baseline, -6, 0)
    c.setFont("Helvetica-Bold", 10.5)
    c.drawCentredString((left + right) / 2, baseline - 13, text)


def _vertical_dimension(c, x, lower, upper, edge, label):
    c.setStrokeColor(black)
    c.setLineWidth(.55)
    c.lines([(edge, lower, x - 4, lower), (edge, upper, x - 4, upper), (x, lower, x, upper)])
    head = min(5, (upper - lower) / 3)
    _arrow(c, x, lower, 0, head)
    _arrow(c, x, upper, 0, -head)
    c.saveState()
    c.translate(x - 7, (lower + upper) / 2)
    c.rotate(90)
    c.setFont("Helvetica-Bold", 10)
    c.drawCentredString(0, 0, label)
    c.restoreState()


def draw_bar_views(c, plan, dimension, rod_callout=None, *, rods_withheld=False, tentative_plate=False):
    """Draw aligned top and side projections and a separately enlarged stock section."""
    c.setStrokeColor(black)
    c.setLineWidth(.7)
    c.lines([(912, 65, 912, 402), (20, 184, 912, 184)])
    write(c, 42, 375, "ASSEMBLY / TOP VIEW", 17, True, black)
    position_note = "Approximate rod positions" if any(plan.rods) else "Rod locations open" if rods_withheld else ""
    fit(c, 42, 357, "  /  ".join(filter(None, ("Bar spacing and placement shown schematically", position_note))), 826, 10.5)

    # Reserve the same horizontal span for both projections. Tying the scale to the
    # stock dimensions keeps both the wide face and the edge in proportion to the length.
    plate_edge = plan.plate_thickness or 0
    bar_length = plan.written_length or 10 * plan.face_width
    scale = min(728 / (bar_length + plate_edge), 134 / plan.plate_width, 63 / plan.plate_height,
                43 / plan.face_width, 38 / plan.stock_thickness)
    width, stock = plan.face_width * scale, plan.stock_thickness * scale
    span = plan.plate_width * scale
    left = 113 + (728 - (bar_length + plate_edge) * scale) / 2
    right = left + bar_length * scale
    center = 279
    # The plate and stock have written sizes, but the sketch does not locate the bars on the plate.
    separation = max(width + 9, span * .58)
    levels = (center + (separation - width) / 2, center - (separation + width) / 2)
    edge = plate_edge * scale
    if tentative_plate:
        c.setDash(4, 2)
    if edge:
        c.rect(right, center - span / 2, edge, span)
    else:
        c.line(right, center - span / 2, right, center + span / 2)
    c.setDash()
    c.setStrokeColor(black)
    c.setLineWidth(1.05)
    for y, rods in zip(levels, plan.rods, strict=True):
        c.rect(left, y, right - left, width)
        c.setDash([9, 3, 2, 3])
        c.setLineWidth(.45)
        c.line(left - 6, y + width / 2, right - 6, y + width / 2)
        c.setDash()
        c.setLineWidth(1.05)
        for along, across in rods:
            x = left + along * (right - left)
            v = y + across * width
            radius = min(5, width / 5)
            c.circle(x, v, radius, stroke=1, fill=0)
            c.lines([(x - radius - 2, v, x + radius + 2, v), (x, v - radius - 2, x, v + radius + 2)])
    _vertical_dimension(c, left - 23, levels[0], levels[0] + width, left - 3, dimension(plan.face_width) + " TYP")
    if plan.written_length:
        _horizontal_dimension(c, left, right, 207, levels[-1] - 3, dimension(plan.written_length) + " REF")

    write(c, 42, 162, "ASSEMBLY / SIDE VIEW", 15, True, black)
    write(c, 42, 146, "One bar in profile", 10, color=black)
    c.setStrokeColor(black)
    c.setLineWidth(1)
    height = plan.plate_height * scale
    bottom = 104 - stock / 2
    c.rect(left, bottom, right - left, stock)
    if tentative_plate:
        c.setDash(4, 2)
    if edge:
        c.rect(right, 104 - height / 2, edge, height)
    else:
        c.line(right, 104 - height / 2, right, 104 + height / 2)
    c.setDash()
    for along, _ in plan.rods[1] or plan.rods[0]:
        x = left + along * (right - left)
        c.line(x, bottom + stock, x, min(138, bottom + stock + 15))
    _vertical_dimension(c, left - 23, bottom, bottom + stock, left - 3, dimension(plan.stock_thickness))

    write(c, 934, 375, "BAR STOCK / END VIEW", 15, True, black)
    section_scale = min(166 / plan.face_width, 78 / plan.stock_thickness)
    w, h = plan.face_width * section_scale, plan.stock_thickness * section_scale
    x, y = 1063 - w / 2, 271
    c.setStrokeColor(black)
    c.setLineWidth(1)
    c.rect(x, y, w, h)
    _horizontal_dimension(c, x, x + w, y - 13, y - 3, dimension(plan.face_width))
    _vertical_dimension(c, x - 15, y, y + h, x - 3, dimension(plan.stock_thickness))
    if rod_callout:
        write(c, 934, 218, "THREADED RODS", 11, True, black)
        for i, line in enumerate(simpleSplit(rod_callout, "Helvetica", 10.5, 246)[:3]):
            write(c, 934, 200 - i * 13, line, 10.5, color=black)
    write(c, 934, 143, "FIT-UP DETAILS TO CONFIRM", 11, True, black)
    fit_up = ["Bar spacing, placement and final length", "Bar-to-plate connections"]
    if rod_callout or any(plan.rods) or rods_withheld:
        fit_up += ["Rod count, pitch, offsets and attachment"]
    for i, label in enumerate(fit_up):
        write(c, 934, 126 - i * 14, label, 10.5, color=black)
