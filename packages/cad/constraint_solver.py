"""Deterministic dimension graph. Pixel hints identify topology, signs and right angles only."""

from __future__ import annotations

import math
import re
import hashlib
from dataclasses import dataclass, field, replace
from fractions import Fraction

import numpy as np
from pydantic import BaseModel, ValidationError

from packages.ai.sketch_parser import Annotation, MappedPart, PagePoint, SketchMap
from .geometry import DraftProfile, Geometry, solve_part
from .schema import BendLine, Drawing, Part, PolygonOutline, Rectangle, RoundHole, Slot

ORIGIN = PagePoint(x=500, y=500)
VULGAR = {
    "¼": "1/4",
    "½": "1/2",
    "¾": "3/4",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
    "⅓": "1/3",
    "⅔": "2/3",
}
NUMBER = r"[+-]?(?:(?:\d+[\s-]+)?\d+\s*/\s*\d+|\d+(?:\.\d*)?|\.\d+)"
UNIT = r'(mm|millimeters?|millimetres?|inches|inch|in|")?'


def plain(text):
    return (
        re.sub(
            r"\s+",
            " ",
            re.sub(r"(\d)([¼½¾⅛⅜⅝⅞⅓⅔])", r"\1 \2", text)
            .translate(str.maketrans(VULGAR))
            .replace("−", "-")
            .replace("″", '"')
            .replace("”", '"'),
        )
        .casefold()
        .strip()
    )


def fraction(text):
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    text = text.lstrip("+-")
    match = re.fullmatch(r"(\d+)(?:\s+|-)(\d+\s*/\s*\d+)", text)
    try:
        value = (
            (Fraction(match[1]) + Fraction(match[2].replace(" ", "")))
            if match
            else Fraction(text.replace(" ", ""))
        )
    except (ValueError, ZeroDivisionError) as exc:
        raise ValueError("Enter a decimal, fraction or mixed number.") from exc
    if value > 1_000_000:
        raise ValueError("Dimension exceeds the supported range.")
    return sign * value


def measurement(text, units, *, angle=False):
    value = plain(text)
    pattern = rf"({NUMBER})\s*(?:°|deg(?:rees?)?)?" if angle else rf"({NUMBER})\s*{UNIT}"
    match = re.fullmatch(pattern, value)
    if not match:
        raise ValueError("Enter the written nominal value and unit. Keep any tolerance in the shop notes.")
    amount = fraction(match[1])
    if not angle and match[2]:
        source = "mm" if match[2].startswith("m") else "in"
        if source != units:
            amount *= Fraction(127, 5) if units == "mm" else Fraction(5, 127)
    return float(amount)


def cited_value(value, source):
    """Accept surrounding punctuation, while keeping fractions, signs and decimal digits together."""
    for match in re.finditer(re.escape(value), source):
        before, after = source[: match.start()], source[match.end() :]
        if value[0].isdigit() or value[0] in ".+-":
            if re.search(r"[\d./+\-]$|/\s+$|\d[ -]+$", before):
                continue
        elif value[0].isalpha() and before[-1:].isalpha():
            continue
        if value[-1].isdigit() and re.match(r"\d|\.\d|\s*/\s*\d|[ -]+\d+\s*/", after):
            continue
        if value[-1].isalpha() and after[:1].isalpha():
            continue
        return True
    return False


def piece_count(text):
    if re.fullmatch(r"[1-9]\d{0,8}", text):
        return int(text)
    count = re.fullmatch(
        r"(?:(?:make|qty|quantity)\s*[:=]?\s*([1-9]\d{0,8})(?:\s+(?:pcs?|pieces?|parts?|units?))?"
        r"|([1-9]\d{0,8})\s+(?:pcs?|pieces?|parts?|units?))\.?", text,
    )
    if count:
        return int(count[1] or count[2])
    raise ValueError("Enter the written piece count as a positive whole number.")


def hole_callout(text, units):
    value = plain(text).replace("⌀", "ø")
    match = re.fullmatch(
        rf"(?:(\d+)\s*[x×]\s*)?(?:ø\s*|dia\.?\s*)?({NUMBER}\s*{UNIT})\s*(?:dia(?:meter)?\.?\s*)?(?:thru|through)?\s*(holes?)?",
        value,
    )
    if not match:
        raise ValueError("Confirm the quantity and through-hole diameter.")
    # A plural label gives a diameter for the marked group. A written count, when provided, still governs.
    count = int(match[1]) if match[1] else (None if match[4] == "holes" else 1)
    return count, measurement(match[2], units)


class WarningPin(BaseModel):
    code: str
    part_id: str | None
    target: str
    annotation: int | None = None
    at: PagePoint
    message: str
    field: str | None = None
    review_key: str | None = None


@dataclass
class DraftPlan:
    geometry: Geometry
    hole_labels: list[str]
    bend_labels: list[str]
    corner_open: bool
    omitted: list[str]


@dataclass
class Solution:
    drawing: Drawing | None
    pins: list[WarningPin]
    snapped_edges: list[dict]
    draft_plans: list[DraftPlan | None] = field(default_factory=list)


@dataclass
class LinearSystem:
    names: list[str]
    rows: list = field(default_factory=list)
    answers: list = field(default_factory=list)
    labels: list = field(default_factory=list)

    def __post_init__(self):
        self.index = {key: i * 2 for i, key in enumerate(self.names)}
        self.size = len(self.names) * 2

    def term(self, name, axis):
        row = np.zeros(self.size)
        row[self.index[name] + axis] = 1.0
        return row

    def offset(self, a, b, axis):
        return self.term(b, axis) - self.term(a, axis)

    def add(self, row, value, target, idx=None):
        self.rows.append(row)
        self.answers.append(value)
        self.labels.append((target, idx))

    def solve(self):
        a = np.asarray(self.rows)
        b = np.asarray(self.answers)
        # Economy SVD for tall systems, full V for systems with fewer equations than unknowns.
        u, s, v = np.linalg.svd(a, full_matrices=a.shape[0] < self.size)
        rank = int(np.count_nonzero(s > max(a.shape) * np.finfo(float).eps * s[0]))
        values = v[:rank].T @ ((u[:, :rank].T @ b) / s[:rank])
        return values, v[rank:], a @ values - b


def fixed(null, row):
    return not len(null) or np.linalg.norm(null @ row) < 1e-8


def review_key(name, evidence):
    checksum = hashlib.sha256(evidence.encode("utf-8")).hexdigest()[:20]
    return f"{name}:{checksum}"


def sketch_note_pins(mapping: SketchMap, accepted=()):
    flags = {}
    for part in mapping.parts:
        for index, mark in enumerate(part.annotations):
            if mark.kind not in ("note", "unsupported"):
                continue
            ink = plain(mark.value + " " + mark.evidence)
            if re.search(r"\bengineer(?:ing)?(?:\s+(?:review|approval))?(?:\s+is)?\s+(?:required|req[’']?d\.?|req\.?)(?![a-z])", ink):
                code, message = "engineering_note", "The sketch calls for engineering review. Confirm the engineering requirements for this revision."
            elif re.search(r"\b(?:might|may|tbd|to be determined|tentative)\b", ink) and re.search(r"\bthick(?:ness|er)?\b", ink):
                code, message = "tentative_thickness", "The sketch says the thickness may change. Confirm the final thickness."
            else:
                continue
            if code not in flags:
                key = review_key(code, part.part_id + ":" + plain(mark.value))
                flags[code] = WarningPin(code=code, part_id=part.part_id, target="P", annotation=index, at=mark.at,
                                        message=message, review_key=key)
    return [item for item in flags.values() if item.review_key not in accepted]


def repeated_engineering_question(text):
    return bool(re.fullmatch(r"engineering review is required(?: as noted on the sketch)?[.!]?", plain(text)))


class PartSolver:
    def __init__(self, part: MappedPart, units, size, pins, snapped, accepted):
        self.p, self.units, self.size = part, units, size
        self.pins, self.snapped, self.accepted = pins, snapped, accepted
        self.pos = {f"V{i}": v for i, v in enumerate(part.vertices, 1)}
        self.pos.update({f"H{i}": h.at for i, h in enumerate(part.holes, 1)})
        for i, b in enumerate(part.bends, 1):
            self.pos.update({f"B{i}.a": b.start, f"B{i}.b": b.end})
        self.center = part.vertices[0] if part.vertices else ORIGIN
        self.vcount = len(part.vertices)
        self.graph = LinearSystem(list(self.pos))
        self.scalars = {}
        self.bearings = {}
        self.spans = {}
        self.lengths = []
        self.dimensions = []
        self.notes = []
        self.edge_names = [f"E{i}" for i in range(1, self.vcount + 1)]

    def anchor(self, target):
        if target in self.edge_names:
            target = "V" + target[1:]
        return self.pos.get(target, self.pos.get(target + ".a", self.center))

    def pin(self, code, target, msg, idx=None, field=None, key=None, at=None):
        point = at or (self.p.annotations[idx].at if idx is not None else self.anchor(target))
        self.pins.append(
            WarningPin(
                code=code,
                part_id=self.p.part_id,
                target=target,
                message=msg,
                annotation=idx,
                at=point,
                field=field,
                review_key=key,
            )
        )

    def confidence(self, value, target, key, at, idx=None):
        if value >= 0.85:
            return
        if idx is not None:
            evidence = self.p.annotations[idx].model_dump_json()
        elif target == "P":
            evidence = self.p.model_dump_json(exclude={"annotations", "questions", "holes", "bends"})
        elif target.startswith("H"):
            evidence = self.p.holes[int(target[1:]) - 1].model_dump_json()
        else:
            evidence = self.p.bends[int(target[1:]) - 1].model_dump_json()
        key = review_key(key, evidence)
        if key not in self.accepted:
            self.pin(
                "low_confidence",
                target,
                "Verify this reading or feature binding against the photo.",
                idx,
                key=key,
                at=at,
            )

    def assign(self, target, key, value, idx):
        name = (target, key)
        if name in self.scalars and self.scalars[name] != value:
            self.pin(
                "conflict", target, f"The two readings for {key.replace('_', ' ')} disagree.", idx, key=None
            )
        else:
            self.scalars[name] = value

    def need(self, target, key):
        val = self.scalars.get((target, key))
        if val is None:
            self.pin("missing", target, f"Enter {key.replace('_', ' ')} for {target}.", field=key)
        return val

    def pair(self, target):
        if target not in self.edge_names:
            raise ValueError("Choose the outside edge referenced by this dimension.")
        i = int(target[1:])
        return f"V{i}", f"V{i % self.vcount + 1}"

    def hint(self, a, b):
        p, q = self.pos[a], self.pos[b]
        return np.array([(q.x - p.x) * self.size[0] / 1000, (p.y - q.y) * self.size[1] / 1000])

    def extrema(self, axis):
        if self.p.shape == "rectangle":
            return ("V1", "V2" if axis == 0 else "V4")
        names = [f"V{i + 1}" for i in range(self.vcount)]
        order = sorted(names, key=lambda k: self.pos[k].x if axis == 0 else -self.pos[k].y)
        return order[0], order[-1]

    def annotation(self, a: Annotation, idx):
        k = a.kind
        targets = a.targets
        t = targets[0]
        edges = set(self.edge_names)
        bends = {f"B{i + 1}" for i in range(len(self.p.bends))}
        openings = {f"H{i + 1}": h.shape for i, h in enumerate(self.p.holes)}
        known = set(self.pos) | edges | bends | {"P"}
        if len(set(targets)) != len(targets) or any(v not in known for v in targets):
            raise ValueError("This annotation points to a missing or repeated feature.")
        self.confidence(a.confidence, t, f"{self.p.part_id}:A{idx + 1}", a.at, idx)
        if k == "unsupported":
            self.pin("unsupported", t, "Clarify this instruction before release: " + a.evidence, idx)
            return
        if k in ("note", "weld"):
            if k == "weld" and t == "P":
                raise ValueError("Bind the weld symbol to its joint or edge.")
            source_adds_detail = plain(a.evidence).rstrip(" .;:") != plain(a.value).rstrip(" .;:")
            self.notes.append(
                f"{', '.join(targets)} | {k.title()}: {a.value}"
                + (f" [{a.evidence}]" if source_adds_detail else "")
            )
            return
        literal = plain(a.value)
        source = plain(a.evidence)
        centered = k in ("center_x", "center_y")
        if centered and not re.search(r"\b(?:cent(?:er|re)\w*|symmetr\w*|midpoint|midline)\b", source):
            raise ValueError("Centering requires a written centering or symmetry instruction.")
        # A numeric literal must be grounded in the transcribed ink. Preserve both for audit.
        if not cited_value(literal, source) and not (
            (k == "radius" and literal in ("square", "0") and ("square" in source or "right angle" in source))
            or (k in ("center_x", "center_y") and any(s in source for s in ("cent", "symmetr")))
        ):
            raise ValueError("The supplied value does not match the cited handwriting.")
        if k in ("material", "quantity", "thickness", "width", "height", "radius"):
            if targets != ["P"]:
                raise ValueError("Bind general part dimensions and stock notes to P.")
            if k == "material":
                val = a.value
            elif k == "quantity":
                val = piece_count(literal)
            elif k == "radius" and literal == "square":
                val = 0.0
            else:
                val = measurement(a.value, self.units)
                if val < 0 or (k != "radius" and val == 0):
                    raise ValueError("Confirm a positive nominal dimension.")
            if k in ("width", "height"):
                self.spans.setdefault(k, []).append((val, idx))
                axis = int(k == "height")
                start, end = self.extrema(axis)
                self.graph.add(self.graph.offset(start, end, axis), val, t, idx)
                self.dimensions.append((start, end, "vertical" if axis else "horizontal", val, k.title()))
            else:
                if k == "radius" and self.p.shape != "rectangle" and val != 0:
                    raise ValueError(
                        "This polygon has a rounded edge. Resolve its arc profile before release."
                    )
                self.assign(t, k, val, idx)
            return
        if k in ("diameter", "hole_callout", "slot_width", "slot_length", "slot_angle"):
            if k == "hole_callout":
                count, val = hole_callout(a.value, self.units)
                if count is not None and count != len(targets):
                    raise ValueError(
                        f"Callout specifies {count} hole(s), but is bound to {len(targets)}. Locate each center."
                    )
            elif k == "slot_angle":
                val = {"horizontal": 0.0, "vertical": 90.0}.get(literal)
                if val is None:
                    val = measurement(literal, self.units, angle=True)
            else:
                val = measurement(literal, self.units)
            for key in targets:
                expected = "slot" if k.startswith("slot") else "round"
                if openings.get(key) != expected:
                    raise ValueError("The opening type and dimension disagree.")
                self.assign(key, "diameter" if k == "hole_callout" else k, val, idx)
            return
        if k in ("bend_angle", "bend_direction"):
            for key in targets:
                if key not in bends:
                    raise ValueError("Bind the bend instruction to a bend line.")
                val = measurement(literal, self.units, angle=True) if k == "bend_angle" else literal
                if k == "bend_direction" and val not in ("up", "down"):
                    raise ValueError("Choose the stated bend direction, up or down.")
                self.assign(key, k, val, idx)
            return
        if k in ("x", "y", "from_right", "from_top", "center_x", "center_y"):
            axis = int(k in ("y", "from_top", "center_y"))
            low, high = self.extrema(axis)
            for key in targets:
                if key not in self.pos:
                    raise ValueError("Choose a vertex, hole center or bend endpoint.")
                if k in ("center_x", "center_y"):
                    self.graph.add(
                        self.graph.term(key, axis)
                        - 0.5 * (self.graph.term(high, axis) + self.graph.term(low, axis)),
                        0,
                        key,
                        idx,
                    )
                else:
                    val = measurement(literal, self.units)
                    row = (
                        self.graph.offset(key, high, axis)
                        if k in ("from_right", "from_top")
                        else self.graph.term(key, axis)
                    )
                    self.graph.add(row, val, key, idx)
            return
        if k in ("dx", "dy", "length"):
            start, end = self.pair(t) if len(targets) == 1 else targets if len(targets) == 2 else (None, None)
            if start not in self.pos or end not in self.pos or start == end:
                raise ValueError("Choose two different dimension endpoints in order.")
            val = measurement(literal, self.units)
            if k == "length":
                if val <= 0:
                    raise ValueError("An edge length must be positive.")
                self.lengths.append((start, end, val, idx, t))
            else:
                self.graph.add(self.graph.offset(start, end, int(k == "dy")), val, t, idx)
            if val:
                self.dimensions.append(
                    (
                        start,
                        end,
                        {"dx": "horizontal", "dy": "vertical", "length": "aligned"}[k],
                        abs(val),
                        f"{t} {k}",
                    )
                )
            return
        if k == "angle":
            if len(targets) != 1 or t not in edges:
                raise ValueError("Choose one edge for a bearing angle.")
            val = measurement(literal, self.units, angle=True) % 360
            if t in self.bearings and not math.isclose(self.bearings[t], val):
                raise ValueError("Two written bearings disagree.")
            self.bearings[t] = val
            return
        raise ValueError("Unsupported dimension binding.")

    def axes(self):
        directions = {}
        hints = []
        for e in self.edge_names:
            a, b = self.pair(e)
            d = self.hint(a, b)
            hints.append(math.degrees(math.atan2(d[1], d[0])) if np.linalg.norm(d) > 1 else None)
        box = (0.0, 90.0, 180.0, 270.0)
        for i, e in enumerate(self.edge_names):
            if self.p.shape == "rectangle":
                directions[e] = box[i]
                if e in self.bearings and abs((self.bearings[e] - box[i] + 180) % 360 - 180) > 1e-7:
                    self.pin(
                        "conflict", e, "The written edge bearing conflicts with the rectangular outline."
                    )
            elif e in self.bearings:
                directions[e] = self.bearings[e]
            elif hints[i] is not None and abs(hints[i] - round(hints[i] / 90) * 90) <= 5 + 1e-10:
                directions[e] = round(hints[i] / 90) * 90
        if not directions and not any(
            a.kind in ("width", "height", "x", "y", "dx", "dy", "from_right", "from_top")
            for a in self.p.annotations
        ):
            # Edge-length-only loops can fix a rigid rotation by convention.
            if hints[0] is not None:
                directions["E1"] = 0.0
        for _ in self.edge_names:
            before = len(directions)
            for i, e in enumerate(self.edge_names):
                j = (i + 1) % len(hints)
                f = self.edge_names[j]
                if hints[i] is None or hints[j] is None:
                    continue
                turn = (hints[j] - hints[i] + 180) % 360 - 180
                if abs(abs(turn) - 90) > 5 + 1e-9:
                    continue
                step = math.copysign(90, turn)
                if e in directions and f not in directions:
                    directions[f] = directions[e] + step
                elif f in directions and e not in directions:
                    directions[e] = directions[f] - step
            if before == len(directions):
                break
        for i, e in enumerate(self.edge_names):
            if e not in directions:
                continue
            a, b = self.pair(e)
            rad = math.radians(directions[e])
            direction = np.array([round(math.cos(rad), 14), round(math.sin(rad), 14)])
            self.graph.add(
                direction[0] * self.graph.offset(a, b, 1) - direction[1] * self.graph.offset(a, b, 0), 0, e
            )
            if e not in self.bearings:
                self.snapped.append(
                    {
                        "part_id": self.p.part_id,
                        "edge": e,
                        "observed_deg": hints[i],
                        "nominal_deg": directions[e] % 360,
                    }
                )
            for start, end, val, idx, t in self.lengths:
                if (start, end) in ((a, b), (b, a)):
                    self.graph.add(
                        direction[0] * self.graph.offset(a, b, 0) + direction[1] * self.graph.offset(a, b, 1),
                        val,
                        t,
                        idx,
                    )
        return directions

    def trilaterate(self, pending, values, null):
        """Two written distances to fixed anchors determine a point up to reflection."""
        anchors = {}
        for a, b, radius, idx, target in pending:
            for known, unknown in ((a, b), (b, a)):
                k = self.graph.index[known]
                if not fixed(null, self.graph.term(known, 0)) or not fixed(null, self.graph.term(known, 1)):
                    continue
                if fixed(null, self.graph.term(unknown, 0)) and fixed(null, self.graph.term(unknown, 1)):
                    continue
                for other, other_radius in anchors.get(unknown, []):
                    if other == known:
                        continue
                    j = self.graph.index[other]
                    baseline = values[k : k + 2] - values[j : j + 2]
                    distance = np.linalg.norm(baseline)
                    if distance <= 1e-8:
                        continue
                    along = (other_radius**2 - radius**2 + distance**2) / (2 * distance)
                    height2 = other_radius**2 - along**2
                    if height2 < -max(other_radius**2 * 1e-10, 1e-9):
                        self.pin(
                            "conflict", target, "The two written distances cannot reach the same point.", idx
                        )
                        continue
                    hint1, hint2 = self.hint(other, known), self.hint(other, unknown)
                    side = hint1[0] * hint2[1] - hint1[1] * hint2[0]
                    if abs(side) <= np.linalg.norm(hint1) and height2 > 1e-10:
                        continue
                    axis = baseline / distance
                    location = (
                        values[j : j + 2]
                        + along * axis
                        + math.copysign(math.sqrt(max(0, height2)), side) * np.array([-axis[1], axis[0]])
                    )
                    for coordinate in (0, 1):
                        self.graph.add(
                            self.graph.term(unknown, coordinate), location[coordinate], target, idx
                        )
                    return True
                anchors.setdefault(unknown, []).append((known, radius))
        return False

    def run(self, *, draft=False):
        part = self.p
        self.confidence(part.confidence, "P", part.part_id + ":P", self.center)
        for question in part.questions:
            self.pin("clarify", "P", question.text, at=question.at)
        if part.shape == "unknown" or self.vcount < 3 or (part.shape == "rectangle" and self.vcount != 4):
            self.pin("topology", "P", "Identify the flat outline and its consecutive corners.")
            return None
        for i, h in enumerate(part.holes, 1):
            self.confidence(h.confidence, f"H{i}", f"{part.part_id}:H{i}", h.at)
            if h.shape == "unknown":
                self.pin("unsupported", f"H{i}", "Confirm the opening profile.")
        for i, b in enumerate(part.bends, 1):
            self.confidence(b.confidence, f"B{i}", f"{part.part_id}:B{i}", b.start)
        for i, a in enumerate(part.annotations):
            if a.kind not in ("weld", "note", "unsupported") and re.search(
                r"±|\+\s*/\s*[-−]|\+\s*[\d.]+\s*/\s*[-−]|\b(?:[Hh]\d{1,2}|toleranc\w*)\b", a.evidence
            ):
                self.notes.append(f"{', '.join(a.targets)} | {a.evidence}")
            try:
                self.annotation(a, i)
            except (ValueError, ZeroDivisionError) as exc:
                self.pin("binding", a.targets[0], str(exc), i)
        self.graph.add(self.graph.term("V1", 0), 0, "V1")
        self.graph.add(self.graph.term("V1", 1), 0, "V1")
        self.axes()
        values, null, residual = self.graph.solve()
        # A measured diagonal plus one known component fixes the other, up to a side choice.
        pending = self.lengths.copy()
        for _ in range(len(pending)):
            progress = False
            for start, end, value, idx, target in pending.copy():
                rows = [self.graph.offset(start, end, axis) for axis in (0, 1)]
                known = [fixed(null, row) for row in rows]
                if not any(known):
                    continue
                if all(known):
                    if not math.isclose(
                        math.hypot(*(r @ values for r in rows)), value, rel_tol=1e-9, abs_tol=1e-8
                    ):
                        self.pin(
                            "conflict",
                            target,
                            "The written length disagrees with its endpoint dimensions.",
                            idx,
                        )
                else:
                    axis = known.index(False)
                    remaining = value**2 - (rows[1 - axis] @ values) ** 2
                    hint = self.hint(start, end)[axis]
                    if remaining < -max(1e-10, value**2 * 1e-10):
                        self.pin(
                            "conflict", target, "The diagonal is shorter than its measured component.", idx
                        )
                    elif abs(hint) > 1 or remaining <= 1e-12:
                        self.graph.add(
                            rows[axis], math.copysign(math.sqrt(max(0, remaining)), hint), target, idx
                        )
                        progress = True
                    else:
                        continue
                pending.remove((start, end, value, idx, target))
            if not progress and not self.trilaterate(pending, values, null):
                break
            values, null, residual = self.graph.solve()
        for offset, error in enumerate(residual):
            if abs(error) > max(1e-8, abs(self.graph.answers[offset]) * 1e-9):
                target, idx = self.graph.labels[offset]
                self.pin(
                    "conflict",
                    target,
                    "Written dimensions cannot all be true. Check the references and nominal values.",
                    idx,
                )
        for name in self.pos:
            for axis, field_name in enumerate(("x", "y")):
                if not fixed(null, self.graph.term(name, axis)):
                    field = field_name
                    target = name
                    if part.shape == "rectangle" and name.startswith("V"):
                        field = "width" if axis == 0 else "height"
                        target = "P"
                    self.pin(
                        "under_constrained",
                        target,
                        f"Add a written {field} dimension for {target}.",
                        field=field,
                    )

        def point(key):
            i = self.graph.index[key]
            return {"x": round(float(values[i]), 10) or 0.0, "y": round(float(values[i + 1]), 10) or 0.0}

        if not len(null):
            xy = np.array([[point(f"V{i + 1}")[k] for k in ("x", "y")] for i in range(self.vcount)])
            for k, entries in self.spans.items():
                actual = np.ptp(xy[:, int(k == "height")])
                for nominal, idx in entries:
                    if not math.isclose(actual, nominal, rel_tol=1e-9, abs_tol=1e-8):
                        self.pin(
                            "conflict",
                            "P",
                            "The solved perimeter disagrees with the written overall " + k + ".",
                            idx,
                        )
            for e, bearing in self.bearings.items():
                a, b = self.pair(e)
                x, y = (point(b)[k] - point(a)[k] for k in ("x", "y"))
                if abs((math.degrees(math.atan2(y, x)) - bearing + 180) % 360 - 180) > 1e-6:
                    self.pin("conflict", e, "The edge direction disagrees with its written bearing.")
        material = self.need("P", "material")
        thickness = self.need("P", "thickness")
        quantity = self.need("P", "quantity")
        if part.shape == "rectangle":
            outline = {
                "kind": "rectangle",
                "width": point("V2")["x"],
                "height": point("V4")["y"],
                "corner_radius": self.need("P", "radius"),
            }
        else:
            outline = {"kind": "polygon", "vertices": [point(f"V{i + 1}") for i in range(self.vcount)]}
        holes = []
        for i, h in enumerate(part.holes, 1):
            target = f"H{i}"
            row = {"shape": h.shape, "center": point(target)}
            if h.shape == "round":
                row["diameter"] = self.need(target, "diameter")
            elif h.shape == "slot":
                row.update(
                    length=self.need(target, "slot_length"),
                    width=self.need(target, "slot_width"),
                    angle=self.need(target, "slot_angle"),
                )
            holes.append(row)
        bends = [
            {
                "start": point(f"B{i}.a"),
                "end": point(f"B{i}.b"),
                "label": f"B{i}",
                "angle": self.scalars.get((f"B{i}", "bend_angle")),
                "direction": self.scalars.get((f"B{i}", "bend_direction")),
            }
            for i in range(1, len(part.bends) + 1)
        ]
        if draft:
            return self.draft_plan(outline, holes, bends, null)
        if any(p.part_id == part.part_id for p in self.pins):
            return None
        dimensions = [
            {"label": label, "start": point(a), "end": point(b), "axis": axis, "value": val}
            for a, b, axis, val, label in self.dimensions
        ]
        try:
            solved = Part.model_validate(
                {
                    "part_id": part.part_id,
                    "name": part.name,
                    "quantity": quantity,
                    "material": material,
                    "thickness": thickness,
                    "outline": outline,
                    "holes": holes,
                    "bends": bends,
                    "dimensions": dimensions,
                    "notes": "\n".join(self.notes),
                }
            )
            solve_part(solved)
            return solved
        except (ValueError, ValidationError) as exc:
            reason = (
                exc.errors(include_input=False)[0]["msg"] if isinstance(exc, ValidationError) else str(exc)
            )
            self.pin("invalid_geometry", "P", reason)
            return None

    def draft_plan(self, outline, openings, bends, null):
        # A contradictory constraint may have moved otherwise fully determined coordinates.
        if any(pin.part_id == self.p.part_id and pin.code in ("conflict", "binding")
               and (pin.annotation is None or self.p.annotations[pin.annotation].kind not in ("material", "quantity", "thickness"))
               for pin in self.pins):
            return None

        def fixed_point(target):
            return all(fixed(null, self.graph.term(target, axis)) for axis in (0, 1))

        if not all(fixed_point(f"V{i}") for i in range(1, self.vcount + 1)):
            return None
        corner_open = outline["kind"] == "rectangle" and outline["corner_radius"] is None
        try:
            if outline["kind"] == "rectangle":
                profile = Rectangle.model_validate({**outline, "corner_radius": 0.0 if corner_open else outline["corner_radius"]})
            else:
                profile = PolygonOutline.model_validate(outline)
            draft = DraftProfile(outline=profile)
            geometry = solve_part(draft)
        except (ValueError, ValidationError):
            return None

        hole_labels, bend_labels, omitted = [], [], []
        holes = []
        for i, row in enumerate(openings, 1):
            target = f"H{i}"
            if fixed_point(target) and row["shape"] in ("round", "slot"):
                try:
                    holes.append((RoundHole if row["shape"] == "round" else Slot).model_validate(row))
                    hole_labels.append(target)
                    continue
                except ValidationError:
                    pass
            omitted.append(target)
        if holes:
            try:
                geometry = solve_part(replace(draft, holes=holes))
            except ValueError:
                omitted.extend(hole_labels)
                hole_labels.clear()
        lines = []
        for i, row in enumerate(bends, 1):
            target = f"B{i}"
            if fixed_point(f"{target}.a") and fixed_point(f"{target}.b"):
                try:
                    lines.append(BendLine.model_validate(row))
                    bend_labels.append(target)
                    continue
                except ValidationError:
                    pass
            omitted.append(target)
        if lines:
            try:
                geometry = solve_part(replace(geometry.part, bends=lines))
            except ValueError:
                omitted.extend(bend_labels)
                bend_labels.clear()
        return DraftPlan(geometry, hole_labels, bend_labels, corner_open, omitted)


def solve_sketch(mapping: SketchMap | dict, page_size, *, revision="1", candidates=(), accepted=(), draft=False):
    mapping = SketchMap.model_validate(mapping)
    source_checks = sketch_note_pins(mapping)
    engineering_check = any(pin.code == "engineering_note" for pin in source_checks)
    pins = [pin for pin in source_checks if pin.review_key not in accepted]
    snapped = []
    accepted = set(accepted)

    def global_pin(code, msg, where=ORIGIN, key=None):
        pins.append(
            WarningPin(code=code, part_id=None, target="drawing", message=msg, at=where, review_key=key)
        )

    evidence = plain(mapping.unit_evidence)
    metric = bool(re.search(r"(?<![a-z])(?:mm|millimet(?:er|re)s?)\b", evidence))
    imperial = bool(re.search(r'(?<![a-z])inch(?:es)?\b|(?<=\d)\s*in\b|"|(?<![a-z])in\.?$', evidence))
    if not mapping.units or not {"in": imperial, "mm": metric}[mapping.units]:
        global_pin("missing", "Confirm inches or millimeters and record the source.")
    elif metric and imperial:
        global_pin(
            "conflict", "Both inch and millimeter conventions are cited. Confirm the primary drawing unit."
        )
    unit_key = review_key("units", str(mapping.units) + " " + mapping.unit_evidence)
    if mapping.unit_confidence < 0.85 and unit_key not in accepted:
        global_pin("low_confidence", "Verify the drawing units.", key=unit_key)
    for q in mapping.questions:
        if not (engineering_check and repeated_engineering_question(q.text)):
            global_pin("clarify", q.text, q.at)
    if not mapping.parts:
        global_pin("topology", "Identify at least one dimensioned flat part.")
    if len({p.part_id.casefold() for p in mapping.parts}) != len(mapping.parts):
        global_pin("binding", "Give each part a unique identifier.")
    refs = {c["id"]: c for c in candidates}
    claimed = [f.candidate for p in mapping.parts for f in [p, *p.holes, *p.bends] if f.candidate]
    ignored = [ref for d in mapping.dismissed for ref in d.ids]
    for ref in set(claimed + ignored):
        if ref not in refs or claimed.count(ref) + ignored.count(ref) > 1:
            global_pin("binding", f"Check duplicate or unknown candidate {ref}.")
    for key in sorted(refs.keys() - set(claimed + ignored)):
        global_pin(
            "unbound",
            f"Identify candidate {key} or mark it as a non-cut mark.",
            PagePoint(**refs[key]["anchor"]),
        )
    parts, drafts = [], []
    if mapping.units:
        for part in mapping.parts:
            if engineering_check:
                part = part.model_copy(update={"questions": [q for q in part.questions if not repeated_engineering_question(q.text)]})
            result = PartSolver(part, mapping.units, page_size, pins, snapped, accepted).run(draft=draft)
            if draft:
                drafts.append(result)
            elif result is not None:
                parts.append(result)
    unique = list(
        {(p.code, p.part_id, p.target, p.annotation, p.message, p.at.x, p.at.y): p for p in pins}.values()
    )
    drawing = (
        None
        if unique or draft
        else Drawing(title=mapping.title, revision=str(revision), units=mapping.units, parts=parts)
    )
    return Solution(drawing, unique, snapped, drafts)
