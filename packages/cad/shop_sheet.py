"""Printable ANSI B shop sheets with dimensional callouts and a datum-based feature schedule."""

from __future__ import annotations

from io import BytesIO
import re

from reportlab.lib.colors import HexColor
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

from .geometry import Geometry, sampled
from .schema import Drawing, Rectangle, RoundHole

PAGE = (1224, 792)
INK = HexColor("#1e2c36")
DETAIL = HexColor("#435e70")
RULE = HexColor("#a8b5bc")
SCRIBE = HexColor("#813f0c")
ROWS = 32


def num(value):
    return format(value, ".10g")


def write(c, x, y, value, size=10, bold=False, color=INK):
    c.setFillColor(color)
    c.setFont("Helvetica-Bold" if bold else "Helvetica", size)
    c.drawString(x, y, str(value))


def fit(c, x, y, value, width, size, bold=False):
    font = "Helvetica-Bold" if bold else "Helvetica"
    measured = c.stringWidth(value, font, size)
    write(c, x, y, value, min(size, size * width / max(measured, 1)), bold)


def section_title(c, x, y, value):
    write(c, x, y, value, 10, True, DETAIL)


def tick(c, x, y):
    c.line(x - 3, y - 4, x + 3, y + 4)


def draw_profile(c, drawing: Drawing, geom: Geometry, *, hole_labels=(), bend_labels=(),
                 viewport=(143.5, 184.5, 555, 415), opening_chain=False, dimension_format=None):
    xmin, ymin, xmax, ymax = geom.bounds
    width, height = xmax - xmin, ymax - ymin
    x, y, view_width, view_height = viewport
    scale = min(view_width / width, view_height / height)
    left = x + (view_width - width * scale) / 2
    bottom = y + (view_height - height * scale) / 2

    def project(p):
        return left + (p[0] - xmin) * scale, bottom + (p[1] - ymin) * scale

    c.setStrokeColor(INK)
    c.setLineWidth(1.5)
    for loop in [geom.outer, *(h.loop for h in geom.inner)]:
        path = c.beginPath()
        points = sampled(loop)
        path.moveTo(*project(points[0]))
        for pt in points[1:]:
            path.lineTo(*project(pt))
        path.close()
        c.drawPath(path)

    for i, hole in enumerate(geom.part.holes, 1):
        x, y = project(hole.center.xy)
        c.setStrokeColor(DETAIL)
        c.setLineWidth(0.55)
        c.line(x - 4, y, x + 4, y)
        c.line(x, y - 4, x, y + 4)
        write(c, x + 5, y + 5, hole_labels[i - 1] if hole_labels else f"H{i}", 8, color=DETAIL)
    if not isinstance(geom.part.outline, Rectangle):
        for i, point in enumerate(geom.part.outline.vertices, 1):
            if i > 1 and point == geom.part.outline.vertices[0]:
                continue
            x, y = project(point.xy)
            write(c, x + 3, y + 3, f"V{i}", 8, color=DETAIL)
    # A feature-bound weld or shop note names the same edge on the plan and in the schedule.
    edge_ids = sorted({int(n) for n in re.findall(r"\bE([1-9]\d{0,2})\b", geom.part.notes)})
    if edge_ids:
        outline = geom.part.outline
        corners = ([(0,0),(outline.width,0),(outline.width,outline.height),(0,outline.height)]
                   if isinstance(outline, Rectangle) else [p.xy for p in outline.vertices])
        for number in edge_ids:
            if number > len(corners):
                continue
            a, b = corners[number-1], corners[number % len(corners)]
            x, y = project(((a[0]+b[0])/2,(a[1]+b[1])/2))
            write(c, x + 4, y + 4, f"E{number}", 8, True, DETAIL)
    for i, bend in enumerate(geom.part.bends, 1):
        a, b = project(bend.start.xy), project(bend.end.xy)
        c.setDash(6, 3)
        c.setStrokeColor(SCRIBE)
        c.setLineWidth(1)
        c.line(*a, *b)
        c.setDash()
        write(c, (a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2 + 3,
              bend_labels[i - 1] if bend_labels else f"B{i}", 8, True, SCRIBE)

    right, top = left + width * scale, bottom + height * scale
    c.setStrokeColor(DETAIL)
    c.setLineWidth(0.65)
    y, x = bottom - 25, left - 31
    for px in (left, right):
        c.line(px, bottom - 4, px, y - 5)
        tick(c, px, y)
    for py in (bottom, top):
        c.line(left - 4, py, x - 5, py)
        tick(c, x, py)
    c.line(left, y, right, y)
    c.line(x, bottom, x, top)
    c.setFillColor(DETAIL)
    c.setFont("Helvetica", 11)
    format_overall = dimension_format or (lambda value: f"{num(value)} {drawing.units}")
    c.drawCentredString((left + right) / 2, y - 15, format_overall(width))
    c.saveState()
    c.translate(x - 7, (bottom + top) / 2)
    c.rotate(90)
    c.drawCentredString(0, 0, format_overall(height))
    c.restoreState()
    holes = geom.part.holes
    if (opening_chain and isinstance(geom.part.outline, Rectangle)
            and 0 < len(holes) <= 6 and all(isinstance(h, RoundHole) for h in holes)
            and all(abs(h.center.y - holes[0].center.y) < 1e-8 for h in holes)):
        ordered = sorted(holes, key=lambda h: h.center.x)
        chain = [xmin, *(h.center.x for h in ordered), xmax]
        # Compact views use the hole schedule when dimension text would collide.
        if min(b - a for a, b in zip(chain, chain[1:])) * scale < 30:
            return
        y = top + 19
        center_y = project(holes[0].center.xy)[1]
        for i, coordinate in enumerate(chain):
            px, _ = project((coordinate, ymin))
            start = center_y + ordered[i - 1].diameter * scale / 2 + 3 if 0 < i < len(chain) - 1 else top + 2
            c.line(px, min(start, y - 4), px, y + 4)
            tick(c, px, y)
        c.line(left, y, right, y)
        c.setFont("Helvetica", 9)
        format_chain = dimension_format or num
        for a, b in zip(chain, chain[1:]):
            midpoint, _ = project(((a + b) / 2, ymin))
            c.drawCentredString(midpoint, y + 6, format_chain(b - a))
        x = right + 16
        c.setDash(4, 2)
        c.line(project(ordered[-1].center.xy)[0] + ordered[-1].diameter * scale / 2, center_y, x + 5, center_y)
        c.setDash()
        c.line(right + 3, top, x + 5, top)
        c.line(x, center_y, x, top)
        tick(c, x, center_y)
        tick(c, x, top)
        c.saveState()
        c.translate(x + 10, (center_y + top) / 2)
        c.rotate(90)
        c.drawCentredString(0, 0, format_chain(ymax - holes[0].center.y))
        c.restoreState()


def schedule(drawing, geom):
    p, unit = geom.part, drawing.units
    yield "Material and blank", True
    yield f"{p.material}   |   {num(p.thickness)} {unit} thick   |   Qty {p.quantity}", False
    if isinstance(p.outline, Rectangle):
        radius = p.outline.corner_radius
        yield f"Corner radius {num(radius)} {unit}" if radius else "Square corners", False
    else:
        yield "Outer profile coordinates", True
        for i, pt in enumerate(p.outline.vertices, 1):
            if i == 1 or pt != p.outline.vertices[0]:
                yield f"V{i}   X {num(pt.x)}   Y {num(pt.y)}", False
    if p.holes:
        yield "Opening coordinates", True
    for i, h in enumerate(p.holes, 1):
        if isinstance(h, RoundHole):
            feature = f"Round hole   DIA {num(h.diameter)}"
        else:
            feature = f"Slot   {num(h.length)} x {num(h.width)} overall   CCW {num(h.angle)}°"
        yield f"H{i}   {feature}   |   X {num(h.center.x)}   Y {num(h.center.y)}", False
    if p.bends:
        yield "Bend / scribe schedule", True
    for i, b in enumerate(p.bends, 1):
        reference = f"B{i}"
        if b.label != reference:
            reference += " " + b.label
        instruction = " ".join(filter(None, [b.direction, f"{num(b.angle)}°" if b.angle else ""]))
        yield (
            (
                f"{reference} {instruction}   |   "
                f"({num(b.start.x)}, {num(b.start.y)}) to ({num(b.end.x)}, {num(b.end.y)})"
            ),
            False,
        )
    if p.dimensions:
        yield "Checked dimensions", True
    for d in p.dimensions:
        tol = (
            f" +{num(d.tolerance_plus)}/-{num(d.tolerance_minus)}"
            if d.tolerance_plus is not None
            else ""
        )
        yield (
            (
                f"{d.label}   {num(d.value)}{tol} {unit}   |   {d.axis}   "
                f"({num(d.start.x)}, {num(d.start.y)}) to ({num(d.end.x)}, {num(d.end.y)})"
            ),
            False,
        )
    if p.notes:
        yield "Shop notes", True
        for paragraph in p.notes.splitlines():
            yield paragraph, False


def wrapped_lines(drawing, geom):
    for value, bold in schedule(drawing, geom):
        if bold:
            yield "", False
        # Bound even a single unbroken customer token by the column width.
        for line in simpleSplit(value, "Helvetica-Bold" if bold else "Helvetica", 10, 361) or [""]:
            font = "Helvetica-Bold" if bold else "Helvetica"
            run, width = "", 0.0
            for character in line:
                advance = stringWidth(character, font, 10)
                if width + advance > 361 and run:
                    yield run, bold
                    run, width = "", 0.0
                run += character
                width += advance
            yield run, bold


def _drawing_index(c, drawing, geometries, starts, total):
    from reportlab.lib.colors import white

    cols = (52, 164, 615, 749, 850, 1018)
    for offset in range(0, len(geometries), ROWS):
        c.setStrokeColor(INK)
        c.rect(24, 24, 1176, 744)
        section_title(c, 44, 739, "LITTLE MOUNTAIN METALWORKS    /    ENGINEERING")
        fit(c, 44, 699, drawing.title, 1130, 28, True)
        section_title(c, 44, 670, "PART INDEX   /   FABRICATION DRAWING SET")
        write(c, 44, 645, "Use the referenced sheets for cut profiles, opening locations and shop notes.", 11)
        y = 609
        c.setFillColor(INK)
        c.rect(44, y - 6, 1136, 24, stroke=0, fill=1)
        for x, value in zip(cols, ("PART ID", "COMPONENT", "MATERIAL", "THICKNESS", "QUANTITY", "DETAIL SHEET")):
            write(c, x, y, value, 9, True, white)
        for i, (geom, sheet) in enumerate(zip(geometries[offset:offset + ROWS], starts[offset:offset + ROWS]), 1):
            p = geom.part
            row = (p.part_id, p.name, p.material, num(p.thickness) + " " + drawing.units, str(p.quantity), str(sheet))
            y = 609 - 16 * i
            c.setStrokeColor(RULE)
            c.setLineWidth(0.35)
            c.line(44, y - 5, 1180, y - 5)
            for x, right, value in zip(cols, (*cols[1:], 1180), row):
                fit(c, x, y, value, right - x - 14, 10)
        write(c, 44, 47, f"REVISION {drawing.revision}   /   {drawing.units}   /   SHEET {offset // ROWS + 1} OF {total}", 10, True)
        c.showPage()


def _paired_details(c, drawing, details):
    c.setStrokeColor(INK)
    c.rect(24, 24, 1176, 744)
    c.line(24, 667, 1200, 667)
    c.line(24, 74, 1200, 74)
    c.setStrokeColor(RULE)
    c.line(612, 74, 612, 667)
    c.line(24, 288, 1200, 288)
    section_title(c, 44, 739, "LITTLE MOUNTAIN METALWORKS    /    ENGINEERING")
    fit(c, 44, 698, drawing.title, 1130, 28, True)
    for x, (geom, lines) in zip((44, 632), details):
        part = geom.part
        section_title(c, x, 638, part.part_id + "   /   FLAT BLANK")
        fit(c, x, 611, part.name, 542, 18, True)
        draw_profile(c, drawing, geom, viewport=(x + 45, 338, 480, 240))
        for i, (value, bold) in enumerate(lines):
            write(c, x, 266 - i * 15, value, 10, bold)
    section_title(c, 44, 47, f"REVISION {drawing.revision}   /   DIMENSIONS IN {drawing.units}   /   SHEET 1 OF 1")
    path = f"DXF kerf {num(drawing.kerf_width)} {drawing.units}" if drawing.kerf_width else "Nominal DXF profiles"
    write(c, 632, 47, path + "   /   Views fitted to the sheet.", 10)
    c.showPage()


def make_pdf(drawing, geometries):
    stream = BytesIO()
    c = Canvas(stream, pagesize=PAGE, invariant=1, pageCompression=1)
    c.setTitle(drawing.title)
    c.setAuthor("Little Mountain Metalworks")
    details = [(geom, list(wrapped_lines(drawing, geom))[1:]) for geom in geometries]
    if len(details) == 2 and all(len(lines) <= 12 for _, lines in details):
        _paired_details(c, drawing, details)
        c.save()
        return stream.getvalue(), [1, 1]
    starts, sheets = [], []
    index_count = (len(geometries) + ROWS - 1) // ROWS if len(geometries) > 1 else 0
    for geom, lines in details:
        starts.append(index_count + len(sheets) + 1)
        sheets.extend((geom, lines[n : n + ROWS], n > 0) for n in range(0, len(lines), ROWS))
    total = index_count + len(sheets)
    if index_count:
        _drawing_index(c, drawing, geometries, starts, total)
    for page, (geom, lines, continuation) in enumerate(sheets, index_count + 1):
        p = geom.part
        c.setLineWidth(1)
        c.setStrokeColor(INK)
        c.rect(24, 24, 1176, 744)
        c.line(24, 674, 1200, 674)
        c.line(24, 99, 1200, 99)
        c.setLineWidth(0.55)
        c.setStrokeColor(RULE)
        c.line(786, 99, 786, 674)
        section_title(c, 44, 741, "LITTLE MOUNTAIN METALWORKS    /    ENGINEERING")
        fit(c, 44, 703, p.name, 747, 28, True)
        section_title(c, 808, 741, "DRAWING")
        fit(c, 808, 704, drawing.title, 368, 16, True)
        section_title(c, 44, 647, "PLAN VIEW     /     FLAT BLANK")
        section_title(
            c, 805, 647, "FEATURE SCHEDULE" + ("    /    CONTINUED" if continuation else "")
        )
        draw_profile(c, drawing, geom)
        for i, (value, bold) in enumerate(lines):
            write(c, 805, 617 - i * 15.5, value, 10, bold)
        unit = drawing.units
        write(
            c,
            44,
            136,
            "Coordinates use the drawing datum. X increases right and Y increases up.",
            10,
            color=DETAIL,
        )
        write(
            c,
            44,
            119,
            f"All dimensions in {unit}. Use written dimensions. View fitted to sheet.",
            10,
            color=DETAIL,
        )
        footer = [
            (44, "PART ID", p.part_id, 199),
            (262, "REVISION", drawing.revision, 145),
            (433, "UNITS", unit, 74),
            (
                534,
                "DXF PATH",
                f"Kerf {num(drawing.kerf_width)} {unit}"
                if drawing.kerf_width
                else "Nominal profile",
                235,
            ),
            (804, "SHEET SIZE", "ANSI B   /   17 x 11 in", 205),
            (1037, "SHEET", f"{page} of {total}", 130),
        ]
        for x, label, value, width in footer:
            section_title(c, x, 73, label)
            fit(c, x, 44, value, width, 14, True)
        c.showPage()
    c.save()
    return stream.getvalue(), starts
