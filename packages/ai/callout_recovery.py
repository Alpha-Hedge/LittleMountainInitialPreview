"""Fill engineering fields only when they are supported by the printed source."""

from __future__ import annotations

import re
from collections import defaultdict
from fractions import Fraction
from typing import Literal

from .schemas import BendSpec, Evidence, HoleSpec, StrictNode, WeldCallout


NUMBER = r"(?:\d+[ -]+\d+\s*/\s*\d+|\d+\s*/\s*\d+|\d+(?:\.\d+)?|\.\d+)"
UNIT = r'(?:"|inches\b|inch\b|in\b|mm\b)'
MEASURE = rf"{NUMBER}\s*{UNIT}"
CHOICE = re.compile(r"\b(?:tbd|verify|optional|tentative|alternat\w*|possibly|if|or|approx(?:imate(?:ly)?)?)\b", re.I)


class CoverageField(StrictNode):
    page: int
    part_id: str
    field: Literal[
        "material_family", "material_grade", "finish", "section_designation", "gauge_designation",
        "quantity", "thickness_in", "stock_size", "outline.width_in", "outline.height_in",
        "outline.corner_radius_in", "holes", "bends", "welds",
    ]
    value: str
    evidence: str


def plain(text):
    return " ".join(text.casefold().split())


def written_notation(text):
    return re.sub(r"(\d)([¼½¾⅛⅜⅝⅞])", r"\1 \2", text).translate(str.maketrans({
        "¼": "1/4", "½": "1/2", "¾": "3/4", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
        "″": '"', "”": '"', "′": "'", "’": "'",
    }))


def _magnitude(value):
    parts = re.split(r"[ -]+(?=\d+\s*/)", value.strip(), maxsplit=1)
    return sum((Fraction(p.replace(" ", "")) for p in parts), Fraction())


def written_measures(excerpt):
    """Read printed nominal measures, including unit-suffixed dimension chains."""
    excerpt = written_notation(excerpt)
    feet = re.compile(rf"(?<![\w.])(\d+)\s*'\s*(?:[-–]\s*)?(?:({NUMBER})\s*\")?")
    values = []
    try:
        for match in feet.finditer(excerpt):
            values.append(float(12 * int(match[1]) + (_magnitude(match[2]) if match[2] else 0)))
        remainder = feet.sub(" ", excerpt)
        chain = re.compile(rf"(?<![\w./])((?:{NUMBER}\s*\"?\s*[x×]\s*)+{NUMBER})\s*({UNIT})", re.I)
        for match in chain.finditer(remainder):
            scale = 25.4 if match[2].lower() == "mm" else 1
            values.extend(float(_magnitude(part.strip().strip('"'))) / scale for part in re.split(r"[x×]", match[1], flags=re.I))
        remainder = chain.sub(" ", remainder)
        for match in re.finditer(rf"(?<![\w./])({NUMBER})\s*({UNIT})", remainder, re.I):
            values.append(float(_magnitude(match[1])) / (25.4 if match[2].lower() == "mm" else 1))
    except (ValueError, ZeroDivisionError, OverflowError):
        return []
    return values


def _contains(excerpt, value):
    return bool(re.search(r"(?<![\w.-])" + re.escape(plain(value)) + r"(?![\w.-])", plain(excerpt)))


def _amount(text, *, zero=False):
    values = written_measures(text)
    return values[0] if len(values) == 1 and (0 <= values[0] <= 1_000_000 if zero else 0 < values[0] <= 1_000_000) else None


_DIMENSION_LABELS = {
    "outline.width_in": r"width|wide",
    "outline.height_in": r"height|high",
    "outline.corner_radius_in": r"corner\s+radius",
}
_ORDER = re.compile(
    r"\b(?:order(?:ed)?|request(?:ed)?|quote)\s+(?:qty\.?|quantity)\s*[:=]?\s*([1-9]\d{0,6})(?![\w./+-])"
    r"|\b(?:make|supply|fabricate)\s+([1-9]\d{0,6})\s+(?:pieces|parts|pcs|units)\b", re.I,
)
_MATERIAL = (r"(?:stainless\s+steel|carbon\s+steel|mild\s+steel|galvanized\s+steel|"
             r"aluminum|aluminium|copper|brass|bronze|titanium|steel)")
_PLATE = re.compile(rf"(?<![\w./])((?:{NUMBER}\s*\"?\s*[x×]\s*){{2}}{MEASURE})\s+(?:FLAT\s+)?PLATE\b", re.I)
_THICK_PLATE = re.compile(rf"^({MEASURE})\s+(?:{_MATERIAL}\s+)?(?:PLATE|SHEET)\b", re.I)
# A rectangular tube is specified by outside width, outside height and wall.
# Match the named stock at the start so a connecting member cannot donate its size.
_TUBE = re.compile(
    rf'^(?P<size>(?:{NUMBER}\s*"?\s*[x×]\s*){{2}}{MEASURE})\s+'
    rf'(?:(?P<material>{_MATERIAL})\s+)?(?:rectangular\s+|square\s+)?tubes?\b', re.I,
)
_UNITS = re.compile(r'\b(?:units\s*[:=]|(?:all\s+)?dimensions\s+(?:are\s+)?in)\s*(inches\b|inch\b|in\b|mm\b)', re.I)
_HOLES = re.compile(
    rf"(?<![\w./])(?P<count>[1-9]\d{{0,2}})\s*(?:[x×]|holes?\b)\s*"
    rf"(?:holes?\s+)?(?:[Øø⌀]|dia(?:meter)?\.?\s*)?\s*(?P<size>{NUMBER}(?:\s*{UNIT})?)"
    r"\s*(?:dia(?:meter)?\.?\s*)?(?:holes?\b|thru\b|through\b)", re.I,
)
_BEND = re.compile(r"\bbent\s+(?:on\s+|at\s+)?(?:the\s+)?top\s+and\s+bottom\b|\b([1-9]\d{0,2})\s+bends\b", re.I)
_FILLET = re.compile(rf"(?<![\w./-])({MEASURE})\s+fillet\s+welds?\b", re.I)


def _reviewed(owner, field):
    return any(ref.source == "review" and field in ref.fields for ref in owner.evidence)


def _add_issue(owner, message):
    if message not in owner.issues and len(owner.issues) < 32:
        owner.issues.append(message)


def _recover_value(part, field, value, excerpt, *, bound, units):
    """Require a field-specific label or construction before applying a number."""
    text = written_notation(excerpt)
    # A numeric part mark followed by a fraction is not a mixed dimension.
    text = re.sub(rf"^(?:(?:part|item|mark)\s+)?{re.escape(part.part_id)}(?:\s*[:|]\s*|\s+)", "", text, flags=re.I)
    tube = _TUBE.match(text) if part.stock_form == "tube" else None
    if field == "quantity":
        relative = r"\s*(?:(?:pieces|parts|pcs\.?|units)\s+)?(?:to\b|per\b|each\b|for each\b|[-–/])"
        eligible = {int(match[1] or match[2]) for match in _ORDER.finditer(text)
                    if not re.match(relative, text[match.end():], re.I)}
        quantity = eligible.pop() if len(eligible) == 1 else 0
        proposed = re.fullmatch(r"([1-9]\d{0,6})(?:\s+(?:pieces|parts|pcs\.?|units))?", value, re.I) if value else None
        return quantity if 0 < quantity <= 1_000_000 and (value is None or (proposed and int(proposed[1]) == quantity)) else None
    if field == "material_family":
        declared = re.compile(rf"\bmaterial\s*[:=]\s*({_MATERIAL})\b", re.I)
        materials = {plain(match[1]) for match in declared.finditer(text)}
        # A material mentioned in a connection note may belong to the other member.
        if part.stock_form in ("plate", "sheet", "tube", "angle", "channel", "beam", "bar", "pipe"):
            stock = re.search(rf"^(?:{MEASURE}\s+)?({_MATERIAL})\s+{part.stock_form}\b", text, re.I)
        elif part.section_designation and plain(excerpt) == plain(part.section_designation):
            stock = re.search(rf"^(?:{MEASURE}\s+)?({_MATERIAL})\b", text, re.I)
        else:
            stock = None
        if stock:
            materials.add(plain(stock[1]))
        if tube and tube["material"]:
            materials.add(plain(tube["material"]))
        if len(materials) == 1 and (value is None or plain(value) in materials):
            return materials.pop()
        return None
    if field in _DIMENSION_LABELS:
        label = _DIMENSION_LABELS[field]
        matches = []
        for match in re.finditer(rf"\b(?:{label})\s*[:=]?\s*({MEASURE})|({MEASURE})\s+(?:{label})\b", text, re.I):
            context = text[max(0, match.start() - 28):match.start()]
            if not re.search(r"\b(?:hole|slot|opening|flange|bend|weld|tab|notch)\b[^.;:]*$", context, re.I):
                number = _amount(match[1] or match[2], zero=field.endswith("radius_in"))
                if number is not None:
                    matches.append(number)
        amount = matches[0] if len(set(matches)) == 1 else None
        return amount if value is None or amount == _amount(value, zero=True) else None
    if field == "thickness_in":
        plate = _PLATE.match(text) if part.stock_form in ("plate", "sheet") else None
        measures = written_measures(plate[1]) if plate else written_measures(tube["size"]) if tube else []
        if len(measures) == 3:
            thickness = measures[-1]
        else:
            labeled = re.search(rf"\b(?:thickness|thick|thk\.?)\s*[:=]?\s*({MEASURE})|({MEASURE})\s+(?:thick|thk)\b", text, re.I)
            direct = _THICK_PLATE.match(text) if bound and part.stock_form in ("plate", "sheet") else None
            thickness = _amount(labeled[1] or labeled[2]) if labeled else _amount(direct[1]) if direct else None
        return thickness if thickness and 0 < thickness <= 1_000_000 and (value is None or thickness == _amount(value)) else None
    if field == "stock_size":
        if tube:
            return tube[0]
        match = _PLATE.match(text) if part.stock_form in ("plate", "sheet") else None
        return match[0] if match else None
    if field == "gauge_designation":
        match = re.search(r"\b\d{1,2}\s*(?:GA\.?|GAUGE)\b", text, re.I)
        return match[0] if match and (value is None or _contains(value, match[0])) else None
    if field == "material_grade":
        grade = r"[\w][\w.-]{1,23}"
        match = re.search(
            rf"\b(?:grade|ASTM|AISI)\s*[:=]?\s*({grade})|\bmaterial\s*:\s*(?:[\w-]+\s+){{0,3}}?"
            r"([A-Z]{0,3}\d{2,4}(?:[A-Z]|-T\d+)?)\b", text, re.I,
        )
        selected = (match[1] or match[2]) if match else None
        return selected if selected and any(d.isdigit() for d in selected) and (value is None or _contains(value, selected)) else None
    if field == "finish":
        match = re.search(
            r"\bfinish\s*[:=]?\s*((?:powder\s*coat(?:ed|ing)?|paint(?:ed)?|galvaniz\w+|"
            r"hot[- ]dip\s+galvaniz\w+|passivat\w+|anodiz\w+|mill\s+finish|as[- ]welded|"
            r"brushed|zinc[- ]plat\w+)(?:\s+RAL\s*\d{4})?)\b", text, re.I,
        )
        if value is not None and _contains(excerpt, value) and match and _contains(value, match[1]):
            return value
        return match[1] if match and value is None else None
    if field == "section_designation":
        if value and _contains(excerpt, value) and re.search(r"\b(?:hss|w\d|c\d|angle|channel|tube|beam|bar|pipe)", value, re.I):
            return value
        return None
    if field == "holes":
        match = _HOLES.search(text)
        if not match:
            return None
        diameter = _amount(match["size"]) or (_amount(match["size"] + " " + units) if units else None)
        if diameter:
            return (int(match["count"]), diameter, "drill" if re.search(r"\bdrill\b", text, re.I) else "unknown")
        return None
    if field == "bends":
        match = _BEND.search(text)
        return (int(match[1]) if match[1] else 2) if match else None
    if field == "welds":
        match = _FILLET.search(text)
        return _amount(match[1]) if match else None
    return None


_FIELDS = (
    "quantity", "material_family", "material_grade", "thickness_in", "gauge_designation", "finish",
    "stock_size", *_DIMENSION_LABELS, "holes", "bends", "welds",
)
_IDENTITY_FIELDS = {"description", "section_designation", "stock_form"}


def _targets(parts, page, excerpt):
    """Find a unique, source-backed owner without using sheet order or proximity."""
    matches = []
    for part in parts:
        keys = [part.section_designation] if part.section_designation and len(part.section_designation) >= 3 else []
        if len(part.part_id) >= 3 and re.search(r"[\d-]", part.part_id):
            keys.append(part.part_id)
        else:
            keys.extend(prefix + " " + part.part_id for prefix in ("part", "item", "mark"))
        keys += [
            ev.excerpt for ev in part.evidence
            if ev.source == "pdf" and ev.page == page and len(ev.excerpt) >= 12
            and set(ev.fields) & _IDENTITY_FIELDS and not ev.excerpt.lower().startswith("visual:")
        ]
        if any(_contains(excerpt, key) for key in keys):
            matches.append(part.part_id)
    return matches


def _stamp(part, owner, fields, page, excerpt, path):
    owner.evidence.append(Evidence(source="pdf", page=page, fields=fields, excerpt=excerpt))
    return [
        {"part_id": part.part_id, "field": path + field, "value": getattr(owner, field),
         "page": page, "evidence": excerpt}
        for field in fields
    ]


def _fill_feature(part, field, value, page, excerpt, unit_ref=None):
    if _reviewed(part, field):
        return []
    rows = getattr(part, field)
    if field == "holes":
        count, diameter, method = value
        def cite_hole(hole, fields, index):
            facts = _stamp(part, hole, fields, page, excerpt, f"holes.{index}.")
            if unit_ref:
                hole.evidence.append(Evidence(source="pdf", page=page, fields=["diameter_in"], excerpt=unit_ref))
            return facts
        if not rows:
            rows.append(HoleSpec(shape="round", count=count, diameter_in=diameter, cutting_method=method, confidence=1.0))
            return cite_hole(rows[0], ["shape", "count", "diameter_in"] + (["cutting_method"] if method == "drill" else []), 0)
        if sum(hole.count for hole in rows) != count or any(
            hole.shape not in ("round", "unknown") or hole.diameter_in not in (None, diameter) for hole in rows
        ):
            return []
        if len(rows) > 1 and not all(any(
            ref.page == page and _contains(ref.excerpt, excerpt) for ref in hole.evidence
        ) for hole in rows):
            return []
        result = []
        for i, hole in enumerate(rows):
            if hole.diameter_in is None and not _reviewed(hole, "diameter_in") and len(hole.evidence) < (31 if unit_ref else 32):
                hole.diameter_in = diameter
                result.extend(cite_hole(hole, ["diameter_in"], i))
        return result
    if field == "bends":
        count = value
        if count > 120 or any(_reviewed(row, "count") for row in rows):
            return []
        result = []
        for _ in range(count - sum(bend.count for bend in rows)):
            rows.append(BendSpec(confidence=1.0))
            result.extend(_stamp(part, rows[-1], ["count"], page, excerpt, f"bends.{len(rows)-1}."))
        return result
    if not rows:
        rows.append(WeldCallout(joint_type="fillet", size_in=value, confidence=1.0))
        return _stamp(part, rows[0], ["joint_type", "size_in"], page, excerpt, "welds.0.")
    if len(rows) == 1 and rows[0].joint_type == "fillet" and rows[0].size_in is None and not _reviewed(rows[0], "size_in") and len(rows[0].evidence) < 32:
        rows[0].size_in = value
        return _stamp(part, rows[0], ["size_in"], page, excerpt, "welds.0.")
    return []


def recover_source_facts(ast, pages, proposals=()):
    """Reconcile a model's exact snippets and the part's own citations with native PDF text."""
    by_id = {part.part_id: part for part in ast.parts}
    printed = {page: plain(text) for page, text in pages.items()}
    page_units = {}
    for page, text in pages.items():
        units = {"mm" if match[1].casefold() == "mm" else "in": " ".join(match[0].split())
                 for match in _UNITS.finditer(text)}
        if len(units) == 1:
            page_units[page] = next(iter(units.items()))
    choices = defaultdict(dict)
    finish_choices = {}

    def consider(part_id, page, field, value, excerpt, *, bound=False):
        excerpt = " ".join(excerpt.split())
        if not 5 <= len(excerpt) <= 400 or plain(excerpt) not in printed.get(page, ""):
            return
        if not bound and _targets(ast.parts, page, excerpt) != [part_id]:
            return
        if value is not None and (not 1 <= len(value) <= 120 or not _contains(excerpt, value)):
            return
        if CHOICE.search(excerpt):
            if field == "finish" and re.search(r"\bfinish\s*[:=]?\b.*\bor\b", excerpt, re.I):
                finish_choices[part_id] = (page, excerpt)
            return
        units, _ = page_units.get(page, (None, None))
        parsed = _recover_value(by_id[part_id], field, value, excerpt, bound=bound, units=units)
        if parsed is not None:
            key = plain(parsed) if isinstance(parsed, str) else parsed
            choices[part_id, field][key] = (parsed, page, excerpt)

    for part in ast.parts:
        for ev in part.evidence:
            if ev.source == "pdf" and _targets(ast.parts, ev.page, ev.excerpt) == [part.part_id]:
                # Even a related drawing note must identify this particular part before supplying facts.
                for field in _FIELDS:
                    consider(part.part_id, ev.page, field, None, ev.excerpt, bound=True)
    for page, text in pages.items():
        for line in text.splitlines():
            if not 5 <= len(line.strip()) <= 400:
                continue
            targets = _targets(ast.parts, page, line)
            if len(targets) == 1:
                for field in _FIELDS:
                    consider(targets[0], page, field, None, line.strip(), bound=True)
    for row in proposals[:120]:
        if row.part_id in by_id:
            consider(row.part_id, row.page, row.field, " ".join(row.value.split()), row.evidence)

    recovered = []
    for (part_id, field), values in choices.items():
        part = by_id[part_id]
        if len(values) != 1:
            if field == "quantity" and part.quantity is None and not _reviewed(part, field):
                _add_issue(part, "The drawing lists different order quantities for this part. Confirm the total to quote.")
            continue
        if field == "finish" and part_id in finish_choices:
            continue
        value, page, excerpt = next(iter(values.values()))
        if field in ("holes", "bends", "welds"):
            hole = _HOLES.search(written_notation(excerpt)) if field == "holes" else None
            unit_ref = page_units[page][1] if hole and page in page_units and not written_measures(hole["size"]) else None
            recovered.extend(_fill_feature(part, field, value, page, excerpt, unit_ref))
            continue
        prefix = "outline." if field.startswith("outline.") else ""
        owner = part.outline if prefix else part
        key = field.removeprefix(prefix) if field != "stock_size" else "section_designation"
        if getattr(owner, key) is not None or _reviewed(owner, key) or len(owner.evidence) >= 32:
            continue
        setattr(owner, key, value)
        recovered.extend(_stamp(part, owner, [key], page, excerpt, prefix))
    for part_id, (page, excerpt) in finish_choices.items():
        part = by_id[part_id]
        if part.finish is None and not _reviewed(part, "finish"):
            _add_issue(part, f"Confirm which finish to quote. Page {page} lists alternatives: {excerpt}")
    return recovered
