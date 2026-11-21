"""Compose the AI illustration and the written dimensions into a printable review sheet."""

from dataclasses import dataclass, replace
from fractions import Fraction
from io import BytesIO
from math import hypot
import re
from types import SimpleNamespace

import pypdfium2 as pdfium
from reportlab.lib.colors import black
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfgen.canvas import Canvas

from packages.ai.sketch_parser import MappedPart

from .bar_views import broad_face, draw_bar_views, draw_stock_views, pictured_rods
from .constraint_solver import measurement as read_measurement
from .pdf_lock import pdfium_lock
from .schema import Rectangle, RoundHole
from .shop_sheet import PAGE, draw_profile, fit, num, write
from .sketch_draft import _details, _page, _printable, _wrapped
from .sketch_verification import disputed_rod_layout

LAYOUT_VERSION = 9


@dataclass(frozen=True)
class Callout:
    key: str
    heading: str
    text: str


@dataclass(frozen=True)
class BarPlan:
    face_width: float
    stock_thickness: float
    written_length: float | None
    rods: tuple[tuple[tuple[float, float], ...], ...]
    plate_width: float
    plate_height: float
    plate_thickness: float | None
    stock_check: bool


@dataclass(frozen=True)
class BarStock:
    part: MappedPart
    source: str
    width: float
    thickness: float
    check: bool


def measurement(value, unit):
    if unit != "in":
        return f"{num(value)} {unit}"
    fraction = Fraction(value).limit_denominator(64)
    if abs(float(fraction) - value) > 1e-8:
        return f'{num(value)}"'
    whole, rest = divmod(fraction.numerator, fraction.denominator)
    if not rest:
        return f'{whole}"'
    return (f"{whole}-" if whole else "") + f'{rest}/{fraction.denominator}"'


def primary_detail(reading, solution):
    plotted = [(p, plan) for p, plan in zip(reading.parts, solution.draft_plans) if plan]
    return max(plotted, key=lambda pair: (
        "plate" in pair[0].name.lower(), len(pair[1].geometry.part.holes)
    ), default=None)


def _part_bar_stock(part, unit):
    if not unit:
        return None
    readings = []
    for mark in part.annotations:
        if mark.kind not in ("width", "thickness", "note") or mark.targets != ["P"]:
            continue
        section = re.match(r"^\s*(.+?)\s*[x×]\s*(.+?)\s+(?:flat\s*)?bars?\b", mark.evidence, re.I)
        if not section:
            continue
        try:
            thickness, width = sorted(read_measurement(value, unit) for value in section.groups())
        except ValueError:
            continue
        if thickness > 0:
            readings.append((thickness, width, mark))
    if not readings or len({(t, w) for t, w, _ in readings}) != 1:
        return None
    thickness, width, source = max(readings, key=lambda entry: entry[2].confidence)
    for mark in part.annotations:
        if mark.kind not in ("width", "thickness") or mark.targets != ["P"]:
            continue
        try:
            if read_measurement(mark.value, unit) != (width if mark.kind == "width" else thickness):
                return None
        except ValueError:
            continue
    strong = {mark.kind for _, _, mark in readings if mark.confidence >= .85}
    return BarStock(part, source.evidence, width, thickness,
                    "note" not in strong and not {"width", "thickness"} <= strong)


def bar_stock(reading):
    stocks = [stock for part in reading.parts if (stock := _part_bar_stock(part, reading.units))]
    return stocks[0] if len(stocks) == 1 else None


def _one_measure(part, kinds, unit):
    values = set()
    for mark in part.annotations:
        if mark.kind not in kinds:
            continue
        if mark.kind == "note" and mark.targets != ["P"]:
            continue
        try:
            value = read_measurement(mark.value, unit)
        except ValueError:
            continue
        if value > 0:
            values.add((value, mark.confidence >= .85))
    distinct = {value for value, _ in values}
    return next(iter(distinct)) if len(distinct) == 1 and any(high for _, high in values) else None


def _long_axis(member):
    face = broad_face(member)
    if not face.is_valid or face.area <= 0:
        return None
    points = list(face.minimum_rotated_rectangle.exterior.coords)
    edges = [(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(points, points[1:])]
    dx, dy = max(edges, key=lambda p: hypot(*p))
    length = hypot(dx, dy)
    return dx / length, dy / length


def _bar_length(stock, unit):
    # Keep the written length as a reference. A suffix such as "@ approx. 32" is never a release dimension.
    lengths = set()
    for mark in stock.part.annotations:
        if mark.kind not in ("length", "unsupported", "note") or mark.targets != ["P"]:
            continue
        suffix = re.search(r"\bbars?\s*(?:@|L\s*[:=])?\s*(?:±|≈|\+/-|approx\.?\s+)?\s*(.+)$",
                           mark.evidence, re.I)
        try:
            value = read_measurement(suffix[1] if suffix else mark.value, unit)
        except ValueError:
            continue
        if value > 0:
            lengths.add(value)
    return next(iter(lengths)) if len(lengths) == 1 else None


def assembly_top_view(reading, detail, assembly):
    """Support the common pair of flat bars projecting from a rectangular backing plate."""
    stock = bar_stock(reading)
    if not (stock and detail and assembly and isinstance(detail[1].geometry.part.outline, Rectangle)):
        return None
    if sorted(member.kind for member in assembly.members) != ["bar", "bar", "plate"]:
        return None
    bars = [member for member in assembly.members if member.kind == "bar"]
    bars.sort(key=lambda member: broad_face(member).centroid.y)
    axes = [_long_axis(member) for member in bars]
    if not all(axes) or abs(sum(a * b for a, b in zip(*axes))) < .97:
        return None
    unit = reading.units
    plate, draft = detail
    outline = draft.geometry.part.outline
    if stock.width * len(bars) > outline.width or stock.thickness > outline.height:
        return None
    return BarPlan(stock.width, stock.thickness, _bar_length(stock, unit), pictured_rods(assembly, bars),
                   outline.width, outline.height, _one_measure(plate, ("thickness",), unit), stock.check)


def written_callouts(reading, detail):
    callouts = []
    notes = [mark.value for part in reading.parts for mark in part.annotations
             if mark.kind == "note" and mark.confidence >= .85]
    for note in notes:
        if re.search(r"\banchors?\b", note, re.I):
            callouts.append(Callout("anchors", "ANCHORS", _printable(note)))
            break
    for note in notes:
        if re.search(r"\bthreaded rod\b", note, re.I) and not re.search(r"\banchor", note, re.I):
            spacing = r"\beq\.?\s+spacing\b|\bequal(?:ly)? spac"
            qualifier = (" / Equal spacing" if not re.search(spacing, note, re.I)
                         and any(re.search(spacing, n, re.I) for n in notes) else "")
            callouts.append(Callout("rod", "THREADED ROD", _printable(note) + qualifier))
            break
    if stock := bar_stock(reading):
        callouts.append(Callout("bar", "BAR STOCK", _printable(stock.source) + (" / Check size" if stock.check else "")))
    if detail:
        part, plan = detail
        bounds = plan.geometry.bounds
        size = " x ".join(measurement(bounds[k + 2] - bounds[k], reading.units) for k in (0, 1))
        if thickness := _one_measure(part, ("thickness",), reading.units):
            size += " / " + measurement(thickness, reading.units) + " thick"
            if any(re.search(r"thickness|thicker", mark.value, re.I)
                   and re.search(r"might|may|increase|confirm", mark.value, re.I)
                   for mark in part.annotations if mark.kind == "note"):
                size += " (tentative)"
        callouts.append(Callout("detail", _printable(part.name).upper(), size))
    return callouts


def _review_notes(reading, solution, callouts):
    annotations = [mark for part in reading.parts for mark in part.annotations]
    displayed = set()
    notes = []
    covered = " ".join(callout.text.casefold() for callout in callouts)
    for mark in annotations:
        value = _printable(mark.value)
        already_tentative = "(tentative)" in covered and re.search(r"thickness|thicker", value, re.I)
        if (mark.kind in ("note", "weld") and mark.confidence >= .85 and value.casefold() not in covered
                and not already_tentative
                and not re.search(r"engineering req|\beq\.?\s+spacing", value, re.I) and value not in displayed):
            notes.append(value)
            displayed.add(value)
    checks, cropped_parts = [], set()
    for pin in solution.pins:
        if pin.code not in ("clarify", "tentative_thickness"):
            continue
        if re.search(r"\bcropped\b", pin.message, re.I):
            if pin.part_id in cropped_parts:
                continue
            cropped_parts.add(pin.part_id)
        check = _printable(pin.message)
        if check not in checks:
            checks.append(check)
    if not checks and solution.pins:
        checks = ["Confirm the open measurements and specifications in the sketch review."]
    return notes, checks


def _isometric(c, art, callouts, anchors, *, compact=False):
    image = ImageReader(BytesIO(art))
    w, h = image.getSize()
    scale = min((478 if compact else 786) / w, (295 if compact else 367) / h)
    center_x, center_y = (401, 560) if compact else (612, 521)
    left = center_x - w * scale / 2
    bottom = center_y - h * scale / 2
    c.drawImage(image, left, bottom, w * scale, h * scale)
    points = []
    text_width, font_size = (121, 9.7) if compact else (163, 11)
    for callout in callouts:
        if len(simpleSplit(callout.text, "Helvetica", font_size, text_width)) > 4:
            continue
        if anchor := anchors.get(callout.key):
            points.append((left + w * scale * anchor.x / 1000,
                           bottom + h * scale * (1 - anchor.y / 1000), callout))
    # Assign the leftmost features to the left margin and space leaders in each margin from top down.
    points.sort(key=lambda entry: entry[0])
    split = (len(points) + 1) // 2 if len(points) > 1 else int(bool(points and points[0][0] <= center_x))
    placed = set()
    columns = ((42, 164, 187), (662, 654, 630)) if compact else ((42, 205, 234), (1010, 1002, 975))
    for (x, end_x, elbow_x), group in zip(columns, (points[:split], points[split:])):
        ceiling = 688
        for px, py, callout in sorted(group, key=lambda entry: -entry[1]):
            y = min(ceiling, max(464 if compact else 405, py))
            lines = simpleSplit(callout.text, "Helvetica", font_size, text_width)
            if y - 10 - max(0, len(lines) - 1) * 13 <= (414 if compact else 332):
                continue
            c.setStrokeColor(black)
            c.setLineWidth(.85)
            c.lines([(end_x, y, elbow_x, y), (elbow_x, y, px, py)])
            c.setFillColor(black)
            c.circle(px, py, 2, stroke=0, fill=1)
            fit(c, x, y + 5, callout.heading, text_width, 11 if compact else 12.5, True)
            for i, line in enumerate(lines):
                write(c, x, y - 10 - i * 13, line, font_size, color=black)
            placed.add(callout.key)
            ceiling = y - max(56, 31 + 13 * len(lines))
    return placed


def _edge_view(c, unit, height, thickness, scale, bottom, *, tentative, x=566, label_width=98):
    width = thickness * scale
    top = bottom + height * scale
    c.setStrokeColor(black)
    c.setLineWidth(1)
    if tentative:
        c.setDash(4, 2)
    c.rect(x, bottom, width, top - bottom)
    c.setDash()
    c.setLineWidth(.55)
    y = bottom - 8
    c.lines([(x, bottom - 2, x, y - 3), (x + width, bottom - 2, x + width, y - 3),
             (x, y, x + width, y)])
    fit(c, x - 16, top + 17, "EDGE VIEW", label_width, 10, True)
    fit(c, x - 16, bottom - 17, measurement(thickness, unit) + " thick", label_width, 10, True)
    if tentative:
        write(c, x - 16, bottom - 29, "Tentative", 9, color=black)


def _detail_panel(c, detail, unit, *, compact, tentative):
    x, header = (824, 743) if compact else (42, 296)
    if not detail:
        write(c, x, header, "PART DETAIL", 17, True, black)
        write(c, 42, 251, "Confirm the written dimensions to add a measured view.", 12, color=black)
        return
    part, plan = detail
    title = _printable(part.name).upper() + " DETAIL / FRONT VIEW"
    fit(c, x, header, title, 358 if compact else 608, 16, True)
    holes = plan.geometry.part.holes
    if holes and all(isinstance(hole, RoundHole) and hole.diameter == holes[0].diameter for hole in holes):
        write(c, x, header - 17, f"{len(holes)} x Ø{measurement(holes[0].diameter, unit)}   /   Plotted holes", 10.5, True, black)
    thickness = _one_measure(part, ("thickness",), unit)
    edge = thickness and isinstance(plan.geometry.part.outline, Rectangle)
    viewport = ((874, 620, 226 if edge else 285, 61) if compact
                else (115, 132, 392 if edge else 463, 112))
    if edge:
        outline = plan.geometry.part.outline
        x_view, y_view, w_view, h_view = viewport
        scale = min(w_view / outline.width, h_view / outline.height, (33 if compact else 61) / thickness)
        w, h = outline.width * scale, outline.height * scale
        bottom = y_view + (h_view - h) / 2
        viewport = (x_view + (w_view - w) / 2, bottom, w, h)
    draw_profile(c, SimpleNamespace(units=unit), plan.geometry, hole_labels=plan.hole_labels,
                 bend_labels=plan.bend_labels, viewport=viewport, opening_chain=True,
                 dimension_format=lambda value: measurement(value, unit))
    if edge:
        if compact:
            _edge_view(c, unit, outline.height, thickness, scale, bottom, tentative=tentative,
                       x=1152, label_width=63)
        else:
            _edge_view(c, unit, outline.height, thickness, scale, bottom, tentative=tentative)
    footing = ["Use the written dimensions."]
    if plan.corner_open:
        footing.append("Corner detail open.")
    if plan.omitted:
        footing.append("Unlocated features are listed in sketch review.")
    fit(c, x, 562 if compact else 77, "  ".join(footing), 358 if compact else 609, 10.5, True)


def _notes_panel(c, rows, *, compact):
    x, header, floor, width, size, step = ((824, 534, 420, 338, 9.7, 12) if compact
                                           else (692, 299, 89, 467, 11.5, 14))
    write(c, x, header, "GENERAL NOTES", 14 if compact else 17, True, black)
    y = header - 21
    for i, value in enumerate(rows, 1):
        words = " ".join(" ".join(word[k:k + 40] for k in range(0, len(word), 40))
                         for word in value.split())
        lines = simpleSplit(words, "Helvetica", size, width)
        if y - (len(lines) - 1) * step < floor:
            write(c, x, floor - 8, "See the sketch review for the remaining details.", 9.5, True, black)
            break
        write(c, x, y, f"{i}.", size, True, black)
        for line in lines:
            write(c, x + 18, y, line, size, color=black)
            y -= step
        y -= 3


def _verification_page(c, revision, audit, open_parts):
    c.showPage()
    c.setStrokeColor(black)
    c.rect(20, 20, 1184, 752)
    write(c, 48, 728, "SKETCH VERIFICATION", 24, True, black)
    write(c, 48, 704, f"SOURCE REVISION {revision}  /  REVIEW COPY", 11, True, black)
    y = 671

    def paragraph(text, *, bold=False):
        nonlocal y
        font = "Helvetica-Bold" if bold else "Helvetica"
        for line in simpleSplit(_printable(text), font, 11.5, 1118):
            if y < 44:
                c.showPage()
                c.rect(20, 20, 1184, 752)
                write(c, 48, 728, "SKETCH VERIFICATION / CONTINUED", 18, True, black)
                y = 700
            write(c, 48, y, line, 11.5, bold, black)
            y -= 15

    paragraph("Written dimensions drive the measured views. The isometric and schematic positions are interpretations.")
    if audit.get("rods_withheld"):
        paragraph("The comparison found a disputed rod layout. The top and side views leave rod locations open.",
                  bold=True)
    if audit["status"] != "checked":
        paragraph("Automatic comparison incomplete. Review the source and all views before using this drawing.", bold=True)
    elif not audit["findings"]:
        paragraph("The automated comparison returned no specific discrepancies. Review the sketch before fabrication.")
    views = {"source": "Source", "measured": "Measured view", "isometric": "Isometric", "across_views": "Across views"}
    for finding in audit["findings"]:
        y -= 8
        paragraph(views[finding["view"]] + " / " + finding["issue"], bold=True)
        paragraph(finding["evidence"])
    for detail in audit["clearances"]:
        y -= 8
        gap = measurement(detail["gap"], detail["units"])
        prefix = "Approximate drawn clearance" if detail["approximate"] else "Minimum drawn opening-to-edge clearance"
        paragraph(f"{prefix} / {detail['part']} {detail['opening']} / {gap}", bold=True)
        paragraph("Calculated from the plotted geometry. Engineering suitability requires separate verification.")
    for part, _, _, pins in open_parts:
        y -= 12
        paragraph(f"{part.part_id}  /  {part.name}  /  PROFILE STILL OPEN", bold=True)
        for line, bold in _part_details(part, None, pins, ""):
            paragraph(line, bold=bold)


def _part_details(part, profile, pins, unit):
    yield from _details(part, profile, pins, unit)
    open_notes = list(dict.fromkeys(mark.value for mark in part.annotations if mark.kind == "unsupported"))
    if open_notes:
        yield "Other written callouts", True
        yield from ((note, False) for note in open_notes)


def _part_sheets(c, reading, revision, entries):
    unit = reading.units
    for part, profile, stock, pins in entries:
        lines = list(_wrapped(_part_details(part, profile, pins, unit), 380))
        for start in range(0, len(lines), 32):
            c.showPage()
            _page(c, part.name, f"{part.part_id}  /  {reading.title}", revision)
            c.setStrokeColor(black)
            c.setLineWidth(.65)
            c.line(780, 78, 780, 660)
            if start:
                write(c, 44, 630, "CONTINUED PART DETAILS", 15, True, black)
            elif stock and not profile:
                draw_stock_views(c, stock, _bar_length(stock, unit), lambda value: measurement(value, unit))
            elif profile:
                write(c, 44, 630, "MEASURED PROFILE", 15, True, black)
                draw_profile(c, SimpleNamespace(units=unit), profile.geometry,
                             hole_labels=profile.hole_labels, bend_labels=profile.bend_labels,
                             viewport=(111, 285, 580, 280), opening_chain=True,
                             dimension_format=lambda value: measurement(value, unit))
                if thickness := _one_measure(part, ("thickness",), unit):
                    _, y_min, _, y_max = profile.geometry.bounds
                    height = y_max - y_min
                    _edge_view(c, unit, height, thickness, min(69 / height, 60 / thickness), 143,
                               tentative=any(pin.code == "tentative_thickness" for pin in pins), x=98)
            else:
                write(c, 44, 630, "PROFILE STILL OPEN", 15, True, black)
                write(c, 44, 605, "Confirm the outline and its dimensions to add a measured view.", 11, color=black)
            for i, (line, bold) in enumerate(lines[start:start + 32]):
                write(c, 799, 630 - i * 16.5, line, 10, bold)


def make_presentation_sheet(reading, revision, art, solution, detail, callouts, anchors, *, assembly=None, audit=None):
    stream = BytesIO()
    c = Canvas(stream, pagesize=PAGE, invariant=1, pageCompression=1)
    c.setTitle(_printable(reading.title) + " - AI review drawing")
    c.setAuthor("Little Mountain Metalworks")
    c.setStrokeColor(black)
    c.setLineWidth(1.5)
    plan = assembly_top_view(reading, detail, assembly)
    drawn = {detail[0].part_id} if detail else set()
    if plan and (stock := bar_stock(reading)):
        drawn.add(stock.part.part_id)
    extra_parts = [
        (part, profile, _part_bar_stock(part, reading.units),
         [pin for pin in solution.pins if pin.part_id == part.part_id])
        for part, profile in zip(reading.parts, solution.draft_plans or [None] * len(reading.parts), strict=True)
        if part.part_id not in drawn
    ]
    section_y = 402 if plan else 321
    c.rect(20, 20, 1184, 752)
    c.line(20, section_y, 1204, section_y)
    c.line(20, 65, 1204, 65)
    if plan:
        c.line(802, section_y, 802, 772)
        c.line(802, 551, 1204, 551)
    else:
        c.line(670, 65, 670, section_y)
    c.line(819, 20, 819, 65)
    c.line(996, 20, 996, 65)
    engineering = any(pin.code == "engineering_note" for pin in solution.pins) or any(
        re.search(r"engineer(?:ing)?\s+req", mark.value, re.I)
        for part in reading.parts for mark in part.annotations
    )
    write(c, 42, 735, "ASSEMBLY / ISOMETRIC" if plan else "ISOMETRIC VIEW", 17, True, black)
    write(c, 42, 715, "NTS / ENGINEERING REQUIRED" if engineering else "NOT TO SCALE", 10, True, black)
    write(c, 634 if plan else 1020, 735, "AI CONCEPT DRAWING", 12.5, True, black)
    if audit:
        label = "SKETCH CHECKS / SHEET 2" if audit["status"] == "checked" else "SOURCE CHECK INCOMPLETE / SHEET 2"
        fit(c, 634 if plan else 1020, 715, label, 158, 9.5, True)
    placed = _isometric(c, art, callouts, anchors, compact=bool(plan))
    tentative = any(callout.key == "detail" and "(tentative)" in callout.text for callout in callouts)
    _detail_panel(c, detail, reading.units, compact=bool(plan), tentative=tentative)
    if plan:
        rod_callout = next((callout.text for callout in callouts if callout.key == "rod"), None)
        rods_withheld = bool(audit and disputed_rod_layout(audit) and any(plan.rods))
        if rods_withheld:
            plan = replace(plan, rods=tuple(() for _ in plan.rods))
        draw_bar_views(c, plan, lambda value: measurement(value, reading.units), rod_callout,
                       rods_withheld=rods_withheld, tentative_plate=tentative)
    notes, checks = _review_notes(reading, solution, callouts)
    rows = [row.text for row in callouts if row.key not in placed] + checks + notes
    _notes_panel(c, rows or ["The isometric view illustrates the assembly arrangement."], compact=bool(plan))
    write(c, 42, 49, "LITTLE MOUNTAIN METALWORKS", 9.5, True, black)
    fit(c, 42, 30, _printable(reading.title).upper(), 746, 16, True)
    write(c, 839, 49, "SOURCE REVISION", 9.5, True, black)
    write(c, 839, 30, f"{revision}  /  {reading.units or 'Units open'}", 13, True, black)
    write(c, 1016, 49, "REVIEW COPY", 9.5, True, black)
    write(c, 1016, 30, "DO NOT FABRICATE", 13, True, black)
    if audit:
        open_parts = [entry for entry in extra_parts if entry[1] is None and entry[2] is None]
        extra_parts = [entry for entry in extra_parts if entry[1] is not None or entry[2] is not None]
        _verification_page(c, revision, audit, open_parts)
    if extra_parts:
        _part_sheets(c, reading, revision, extra_parts)
    c.save()
    return stream.getvalue()


def presentation_png(pdf):
    with pdfium_lock, pdfium.PdfDocument(pdf) as document:
        page = document[0]
        try:
            bitmap = page.render(scale=1.6)
            try:
                out = BytesIO()
                bitmap.to_pil().save(out, "PNG")
                return out.getvalue()
            finally:
                bitmap.close()
        finally:
            page.close()


def saved_illustration(pdf):
    """Recover the illustration from an earlier sheet for a layout-only update."""
    with pdfium_lock, pdfium.PdfDocument(pdf) as document:
        page = document[0]
        try:
            image, = page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_IMAGE])
            out = BytesIO()
            image.extract(out, fb_format="png")
            return out.getvalue()
        finally:
            page.close()
