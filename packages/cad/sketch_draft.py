"""Printable sketch drafts with partial, dimension-driven plan views."""

from io import BytesIO
import re
from types import SimpleNamespace

from reportlab.lib.colors import HexColor
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfgen.canvas import Canvas

from .constraint_solver import VULGAR, solve_sketch
from .schema import Rectangle, RoundHole
from .shop_sheet import DETAIL, INK, PAGE, RULE, SCRIBE, draw_profile, fit, num, section_title, write

ROWS = 33
_PRINTABLE = str.maketrans({
    "≈": " approx. ", "≃": " approx. ", "⌀": "DIA ", "∅": "DIA ", "Ø": "DIA ",
    **VULGAR,
    "″": '"', "′": "'", "−": "-", "±": "+/-",
})


def _printable(text):
    return re.sub(r"(\d)([¼½¾⅛⅜⅝⅞⅓⅔])", r"\1 \2", text).translate(_PRINTABLE)


def _page(pdf, title, subtitle, revision):
    pdf.setStrokeColor(RULE)
    pdf.rect(24, 24, 1176, 744)
    pdf.line(24, 660, 1200, 660)
    pdf.line(24, 78, 1200, 78)
    section_title(pdf, 44, 737, "LITTLE MOUNTAIN METALWORKS")
    write(pdf, 1050, 737, "DRAFT DRAWING", 15, True, SCRIBE)
    fit(pdf, 44, 698, _printable(title), 1100, 24, True)
    fit(pdf, 44, 675, _printable(subtitle), 1100, 11)
    write(pdf, 44, 47, "DRAFT DRAWING  /  REVIEW COPY", 11, True, SCRIBE)
    section_title(pdf, 724, 47, f"SOURCE REVISION {revision}")
    section_title(pdf, 1030, 47, "ANSI B  /  17 x 11")


def _photo(pdf, image, x, y, width, height):
    w, h = image.getSize()
    scale = min(width / w, height / h)
    pdf.drawImage(image, x + (width - w * scale) / 2, y + (height - h * scale) / 2, w * scale, h * scale)


def _details(part, plan, pins, units):
    yield "Read from the sketch", True
    readings = () if part is None else part.annotations
    seen = set()
    for mark in readings:
        if mark.kind == "unsupported":
            continue
        target = ", ".join(target for target in mark.targets if target != "P")
        value = f"{mark.kind.replace('_', ' ').capitalize()}  /  {mark.value}"
        text = f"{target}  /  {value}" if target else value
        if text not in seen:
            seen.add(text)
            yield text, False
    if not seen:
        yield "See the source photo for the original notes.", False
    if plan and plan.geometry.part.holes:
        yield "Plotted opening centers", True
        shape = plan.geometry.part
        for label, hole in zip(plan.hole_labels, shape.holes):
            size = f"DIA {num(hole.diameter)} {units}" if isinstance(hole, RoundHole) else (
                f"{num(hole.length)} x {num(hole.width)} {units}"
            )
            if isinstance(shape.outline, Rectangle):
                offset = f"{num(hole.center.x)} {units} from left, {num(shape.outline.height - hole.center.y)} {units} below top"
            else:
                offset = f"X {num(hole.center.x)} {units}, Y {num(hole.center.y)} {units} (V1 datum)"
            yield f"{label}  /  {size}  /  {offset}", False
    issues = list(dict.fromkeys(
        pin.message if pin.target in ("P", "drawing") else f"{pin.target}  /  {pin.message}" for pin in pins
    ))
    if plan and plan.corner_open:
        issues.insert(0, "Corner detail open. The plan shows the overall footprint.")
    if plan and plan.omitted:
        issues.insert(0, "Features left off the plan: " + ", ".join(plan.omitted) + ".")
    if issues:
        yield "Open details", True
        yield from ((issue, False) for issue in issues)


def _wrapped(rows, width=366):
    for line, bold in rows:
        font = "Helvetica-Bold" if bold else "Helvetica"
        # Break unusually long tokens before wrapping the notes column.
        safe = " ".join(" ".join(word[i:i + 46] for i in range(0, len(word), 46))
                        for word in _printable(line).split())
        for entry in simpleSplit(safe, font, 10, width):
            yield entry, bold


def _draw_assembly(pdf, assembly, source_size):
    points = [p for member in assembly.members for face in member.faces for p in face.corners]
    xmin, xmax = min(p.x for p in points), max(p.x for p in points)
    ymin, ymax = min(p.y for p in points), max(p.y for p in points)
    ratio = source_size[0] / source_size[1]
    width, height = (xmax - xmin) * ratio, ymax - ymin
    scale = min(622 / width, 276 / height)
    left, top = 365 - width * scale / 2, 470 + height * scale / 2

    def project(p):
        return left + (p.x - xmin) * ratio * scale, top - (p.y - ymin) * scale

    # Front/back faces stay in the same projection as the source, independent of shop dimensions.
    face_colors = [HexColor("#edf2f4"), HexColor("#dfe7ea"), HexColor("#d2dde1")]
    badges = []
    pdf.setLineJoin(1)
    for i, member in enumerate(assembly.members, 1):
        for k, face in enumerate(member.faces):
            corners = [project(p) for p in face.corners]
            line = pdf.beginPath()
            line.moveTo(*corners[0])
            for xy in corners[1:]:
                line.lineTo(*xy)
            line.close()
            pdf.setStrokeColor(INK)
            pdf.setFillColor(face_colors[k % len(face_colors)])
            pdf.setLineWidth(1.35)
            pdf.drawPath(line, stroke=1, fill=1)
        # Use the broadest visible face to place its part identifier.
        main = max(member.faces, key=lambda face: abs(sum(
            a.x * b.y - b.x * a.y for a, b in zip(face.corners, face.corners[1:] + face.corners[:1])
        )))
        xy = [project(p) for p in main.corners]
        badges.append((i, sum(x for x, _ in xy) / len(xy), sum(y for _, y in xy) / len(xy)))
    for group in assembly.hardware:
        for mark in group.marks:
            if not (xmin <= mark.at.x <= xmax and ymin <= mark.at.y <= ymax):
                continue
            x, y = project(mark.at)
            pdf.setStrokeColor(DETAIL)
            pdf.setFillColor(HexColor("#ffffff"))
            pdf.setLineWidth(1)
            if group.kind == "rod" and mark.tip:
                tx, ty = project(mark.tip)
                # Omit unbound paths well outside the member envelope.
                if abs(tx - x) > 80 or abs(ty - y) > 80 or not (44 <= tx <= 692 and 330 <= ty <= 615):
                    continue
                pdf.setLineWidth(2.4)
                pdf.line(x, y, tx, ty)
                pdf.setLineWidth(0.8)
                pdf.line(tx - 2.5, ty, tx + 2.5, ty)
            else:
                pdf.circle(x, y, 3.5, stroke=1, fill=1)
    for index, x, y in badges:
        pdf.setFillColor(INK)
        pdf.circle(x, y, 9, stroke=0, fill=1)
        pdf.setFillColor(HexColor("#ffffff"))
        pdf.setFont("Helvetica-Bold", 9)
        pdf.drawCentredString(x, y - 3, str(index))


def _assembly_sheet(pdf, reading, assembly, revision, image, parts):
    """Keep the pictorial view, its schedule, and the dimensioned detail on one sheet."""
    _page(pdf, reading.title, "Assembly overview  /  " + reading.units, revision)
    pdf.setStrokeColor(RULE)
    pdf.line(704, 78, 704, 660)
    pdf.line(24, 310, 704, 310)
    pdf.line(704, 390, 1200, 390)
    section_title(pdf, 44, 633, "ASSEMBLY VIEW   /   NOT TO SCALE")
    _draw_assembly(pdf, assembly, image.getSize())
    write(pdf, 44, 322, "Arrangement shown from source. Numbered tags identify the members below.", 10, color=DETAIL)

    # A dedicated plate detail is more useful here than an arbitrary part from the list.
    solved = [entry for entry in parts if entry[1]]
    detail = next((entry for entry in solved if "plate" in entry[0].name.casefold()), solved[0] if solved else None)
    section_title(pdf, 724, 633, "DIMENSIONED PLAN" if detail else "SOURCE REFERENCE")
    if detail:
        part, plan, pins = detail
        fit(pdf, 724, 606, f"{part.part_id}  /  {_printable(part.name)}", 450, 17, True)
        draw_profile(pdf, SimpleNamespace(units=reading.units), plan.geometry,
                     hole_labels=plan.hole_labels, bend_labels=plan.bend_labels,
                     viewport=(773, 446, 365, 124), opening_chain=True)
        if plan.corner_open:
            write(pdf, 724, 403, "Outline shown at overall size. Corner detail is open.", 10, color=SCRIBE)
    else:
        _photo(pdf, image, 724, 409, 453, 195)

    # Keep component tags unique even when several members share the same written callout.
    component_rows = [("COMPONENTS SHOWN", True)]
    groups = {}
    for i, member in enumerate(assembly.members, 1):
        label = (member.label, member.callout)
        groups.setdefault(label, []).append(str(i))
    for (label, callout), numbers in groups.items():
        component_rows.append((f"{', '.join(numbers)}   {label}" + (f"  /  {callout}" if callout else ""), False))
    for group in assembly.hardware:
        component_rows.append((group.label + (f"  /  {group.callout}" if group.callout else ""), False))
    component_rows.append(("Hardware marks are a visual reference. Confirm the install locations and counts.", False))

    detail_rows = []
    if detail:
        part, plan, pins = detail
        thickness = [mark.value for mark in part.annotations if mark.kind == "thickness"]
        if thickness:
            detail_rows.append(("Thickness on sketch: " + " / ".join(dict.fromkeys(thickness)), False))
        opening_rows = list(_details(None, plan, [], reading.units))
        if plan.geometry.part.holes:
            start = opening_rows.index(("Plotted opening centers", True))
            detail_rows.extend(opening_rows[start:start + 1 + len(plan.geometry.part.holes)])

    shown_callouts = " ".join(_printable(text).casefold() for text, _ in component_rows)
    notes = list(dict.fromkeys(
        mark.value for part, _, _ in parts if part
        for mark in part.annotations if mark.kind in ("note", "weld", "unsupported")
        and _printable(mark.value).casefold().strip(". ") not in shown_callouts
    ))
    checks = list(dict.fromkeys([
        *assembly.open_details,
        *(pin.message for _, _, pins in parts for pin in pins
          if ((pin.code == "engineering_note" and not any("engineer" in note.casefold() for note in assembly.open_details))
              or (pin.code == "tentative_thickness" and not any("thickness" in note.casefold() for note in assembly.open_details)))),
        *(pin.message for _, _, pins in parts for pin in pins if pin.code == "clarify"),
        *(f"{part.part_id} {part.name}: {pin.message.removesuffix(' for P.')}" for part, plan, pins in parts
          if plan for pin in pins if pin.code == "missing" and pin.field != "radius"),
    ]))
    if checks:
        detail_rows.extend([("DETAILS TO CONFIRM", True), *((check, False) for check in checks)])
    if notes:
        # Keep the review decisions next to the measured detail. Keep the full source wording with the tags.
        component_rows.extend([("SOURCE CALLOUTS", True), *((note, False) for note in notes)])

    def fit_rows(rows, width, limit):
        blocks = [list(_wrapped([row], width)) for row in rows]
        placed = []
        for i, block in enumerate(blocks):
            next_item = len(blocks[i + 1]) if rows[i][1] and i + 1 < len(blocks) else 0
            if len(placed) + len(block) + next_item > limit:
                return placed, rows[i:]
            placed.extend(block)
        return placed, []

    detail_lines, more_details = fit_rows(detail_rows, 453, 22)
    if more_details and not more_details[0][1]:
        more_details = [("DETAILS TO CONFIRM, CONTINUED", True), *more_details]
    component_lines, overflow_rows = fit_rows(component_rows + more_details, 636, 16)
    for x, y, lines in [(44, 286, component_lines), (724, 367, detail_lines)]:
        for i, (line, bold) in enumerate(lines):
            write(pdf, x, y - i * 12.5, line, 10, bold)
    if overflow_rows:
        write(pdf, 44, 86, "More notes on the following sheet.", 10, True, DETAIL)
    pdf.showPage()
    overflow = list(_wrapped(overflow_rows, 540))
    for n in range(0, len(overflow), ROWS * 2):
        _page(pdf, "Assembly notes", reading.title, revision)
        section_title(pdf, 44, 633, "CONTINUED SOURCE CALLOUTS AND CONFIRMATION ITEMS")
        for i, (line, bold) in enumerate(overflow[n:n + ROWS * 2]):
            x, y = (44 if i < ROWS else 620), 607 - (i % ROWS) * 15.5
            write(pdf, x, y, line, 10, bold)
        pdf.showPage()
    return detail


def make_sketch_draft(reading, revision, evidence, photo, accepted=(), *, assembly=None):
    result = solve_sketch(
        reading, evidence["registration"]["size"], revision=revision,
        candidates=evidence["candidates"], accepted=accepted, draft=True,
    )
    image = ImageReader(BytesIO(photo))
    stream = BytesIO()
    pdf = Canvas(stream, pagesize=PAGE, pageCompression=1, invariant=1)
    pdf.setTitle("Draft drawing - " + reading.title)
    pdf.setAuthor("Little Mountain Metalworks")
    parts = []
    for index, part in enumerate(reading.parts or [None]):
        plan = result.draft_plans[index] if result.draft_plans else None
        identifier = part.part_id if part else None
        pins = [pin for pin in result.pins if pin.part_id == identifier or (index == 0 and pin.part_id is None)]
        parts.append((part, plan, pins))
    assembled = assembly and assembly.members
    main_detail = _assembly_sheet(pdf, reading, assembly, revision, image, parts) if assembled else None
    for entry in parts:
        part, plan, pins = entry
        if assembled and (plan is None or entry is main_detail):
            continue
        identifier = part.part_id if part else None
        rows = list(_wrapped(_details(part, plan, pins, reading.units)))
        subtitle = f"{identifier}   /   {reading.title}" if identifier else reading.title
        for start in range(0, len(rows), ROWS):
            _page(pdf, part.name if part else reading.title, subtitle, revision)
            pdf.setStrokeColor(RULE)
            pdf.line(786, 78, 786, 660)
            section_title(pdf, 44, 630, "CONTINUED NOTES" if start else
                          ("DIMENSIONED PLAN" if plan else "SOURCE REFERENCE   /   NOT TO SCALE"))
            if start:
                section_title(pdf, 44, 602, "See the preceding drawing sheet for the view.")
            elif plan:
                draw_profile(pdf, SimpleNamespace(units=reading.units), plan.geometry,
                             hole_labels=plan.hole_labels, bend_labels=plan.bend_labels)
                note = "Overall footprint shown. Corner detail is open." if plan.corner_open else "View fitted to the sheet. Use the written dimensions."
                write(pdf, 44, 102, note, 10, color=DETAIL)
            else:
                _photo(pdf, image, 44, 126, 721, 470)
                write(pdf, 44, 102, "See the source and the open details alongside it.", 10, color=DETAIL)
            for i, (line, bold) in enumerate(rows[start:start + ROWS]):
                write(pdf, 804, 630 - i * 15.5, line, 10, bold)
            pdf.showPage()
    pdf.save()
    return stream.getvalue()
