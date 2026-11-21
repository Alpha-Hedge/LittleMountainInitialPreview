"""Deterministic rectangular blank layouts on compatible sheets, in drawing units."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from math import ceil
from typing import Annotated

from pydantic import Field

from .schema import Drawing, Label, Model, Size

Nonnegative = Annotated[float, Field(ge=0, le=1_000_000)]


class Stock(Model):
    material: Label
    thickness: Size
    width: Size
    height: Size
    margin: Nonnegative
    spacing: Nonnegative
    allow_rotate: bool


class NestRequest(Model):
    drawing: Drawing
    stock: Annotated[list[Stock], Field(min_length=1, max_length=100)]


class Placement(Model):
    part_id: Label
    x: float
    y: float
    width: float
    height: float
    rotated: bool


class Sheet(Model):
    stock: Stock
    placements: list[Placement]


class NestResult(Model):
    units: str
    sheets: list[Sheet]
    sheet_count: int
    net_yield_percent: float
    blank_yield_percent: float
    unused_blank_area: float


def dec(value):
    if isinstance(value, str) and len(value) > 64:
        raise ValueError("Enter a stock dimension with at most 64 characters.")
    try:
        n = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Enter a numeric stock dimension.") from exc
    if not n.is_finite():
        raise ValueError("Stock dimensions must be finite.")
    return n


def _batch_grid(width, height, w, h, gap, rotate):
    """Repeated part rows, with an optional 90-degree row group. Same row pitch per group."""
    best = (0, 0, 0, False)
    for swapped in [False, True] if rotate and w != h else [False]:
        a, b = (h, w) if swapped else (w, h)
        columns = int((width + gap) // (a + gap))
        max_rows = int((height + gap) // (b + gap))
        other_columns = int((width + gap) // (b + gap)) if rotate and a != b else 0
        # Extreme part/sheet ratios need a bounded search. First/last rows are
        # feasible candidates; the reported capacity is always backed by a layout.
        if max_rows <= 2048 and other_columns:
            candidates = range(max_rows + 1)
        elif other_columns:
            candidates = [*range(33), *range(max_rows - 32, max_rows + 1)]
        else:
            candidates = [max_rows]
        for n in candidates:
            n2 = int((height + gap - n * (b + gap)) // (a + gap)) if other_columns else 0
            count = columns * n + other_columns * n2
            if count > best[0] and (columns or n == 0):
                best = count, n, n2, swapped
    return best


def plan_rectangular_batch(
    stock_width, stock_height, blank_width, blank_height, margin, gap, allow_rotation, quantity
):
    sw, sh, w, h, m, g = map(
        dec, (stock_width, stock_height, blank_width, blank_height, margin, gap)
    )
    if (
        min(w, h, sw, sh) <= Decimal("1e-8")
        or max(w, h, sw, sh, m, g) > 1_000_000
        or min(m, g) < 0
        or min(sw, sh) <= m * 2
    ):
        raise ValueError("Sheet, blank size, edge margin, and gap must leave usable sheet area.")
    if (
        type(allow_rotation) is not bool
        or type(quantity) is not int
        or not 1 <= quantity <= 1_000_000_000
    ):
        raise ValueError(
            "Choose rotation permission and a whole quantity between 1 and 1,000,000,000."
        )
    capacity, *_ = _batch_grid(sw - 2 * m, sh - 2 * m, w, h, g, allow_rotation)
    if capacity < 1:
        raise ValueError("The blank will not fit the specified sheet, margin, and rotation.")
    sheet_count = (quantity + capacity - 1) // capacity
    total, blank = sheet_count * sw * sh, quantity * w * h
    return {
        "sheet_count": sheet_count,
        "pieces_per_sheet": capacity,
        "yield_percent": float(100 * blank / total),
        "unused_area": float(total - blank),
    }


@dataclass(frozen=True)
class FreeRect:
    x: Decimal
    y: Decimal
    w: Decimal
    h: Decimal


def options(free, w, h, rotation, gap):
    for i, r in enumerate(free):
        for rotated in [False, True] if rotation and w != h else [False]:
            a, b = (h, w) if rotated else (w, h)
            if a + gap <= r.w and b + gap <= r.h:
                yield (
                    min(r.w - a - gap, r.h - b - gap),
                    max(r.w - a - gap, r.h - b - gap),
                    i,
                    rotated,
                )


def plan_stock(request: NestRequest | dict) -> NestResult:
    from .geometry import solve_part

    request = NestRequest.model_validate(request)
    drawing = request.drawing
    if sum(p.quantity for p in drawing.parts) > 1000:
        raise ValueError(
            "A coordinate nest supports 1,000 pieces. Use the batch planner for a larger identical run."
        )
    geometry = [solve_part(p) for p in drawing.parts]
    if drawing.kerf_width:
        from .dxf_compiler import cut_loops

        for part in geometry:
            cut_loops(part, drawing.kerf_width)
    specs = sorted(request.stock, key=lambda s: (s.width * s.height, s.width, s.height))
    groups = {}
    for spec in specs:
        key = (spec.material.casefold(), dec(spec.thickness))
        if key in groups:
            raise ValueError(
                "Choose one stock size per material and thickness for each nesting run."
            )
        groups[key] = spec
    sheets = []
    total_blank = total_net = 0
    for key, parts in _partition(geometry).items():
        if key not in groups:
            raise ValueError(f"Choose stock for {key[0]} at thickness {key[1]}.")
        stock = groups[key]
        sw, sh, kerf = dec(stock.width), dec(stock.height), dec(drawing.kerf_width)
        margin, gap = dec(stock.margin) + kerf, dec(stock.spacing) + 2 * kerf
        width, height = sw - 2 * margin, sh - 2 * margin
        if min(width, height) <= 0:
            raise ValueError("The specified edge margin and kerf consume the stock.")
        items = []
        for g in parts:
            x0, y0, x1, y1 = g.bounds
            w, h = dec(x1) - dec(x0), dec(y1) - dec(y0)
            if not list(
                options(
                    [FreeRect(margin, margin, width + gap, height + gap)],
                    w,
                    h,
                    stock.allow_rotate,
                    gap,
                )
            ):
                raise ValueError(f"{g.part.part_id} will not fit the selected stock.")
            items.extend([(g.part.part_id, w, h)] * g.part.quantity)
            total_net += g.net_area * g.part.quantity
            total_blank += float(w * h) * g.part.quantity
        items.sort(key=lambda it: (-max(it[1:]), -min(it[1:]), it[0]))
        if len(parts) == 1:
            pid, w, h = items[0]
            _, n1, n2, swapped = _batch_grid(width, height, w, h, gap, stock.allow_rotate)
            remaining = len(items)
            while remaining:
                sheet = Sheet(stock=stock, placements=[])
                y = margin
                for rows, rotated in ((n1, swapped), (n2, not swapped)):
                    a, b = (h, w) if rotated else (w, h)
                    cols = int((width + gap) // (a + gap))
                    if not remaining or not rows or not cols:
                        continue
                    for _ in range(min(rows, ceil(remaining / cols))):
                        for col in range(min(cols, remaining)):
                            _append(sheet, pid, margin + col * (a + gap), y, a, b, rotated)
                            remaining -= 1
                        y += b + gap
                sheets.append(sheet)
            continue
        group_sheets, free_rects = [], []
        for pid, w, h in items:
            candidates = [
                (score, sid)
                for sid, free in enumerate(free_rects)
                for score in options(free, w, h, stock.allow_rotate, gap)
            ]
            if not candidates:
                sid = len(group_sheets)
                group_sheets.append(Sheet(stock=stock, placements=[]))
                free_rects.append([FreeRect(margin, margin, width + gap, height + gap)])
                candidates = [
                    (s, sid) for s in options(free_rects[sid], w, h, stock.allow_rotate, gap)
                ]
            (_, _, i, rotated), sid = min(candidates)
            rect = free_rects[sid].pop(i)
            a, b = (h, w) if rotated else (w, h)
            _append(group_sheets[sid], pid, rect.x, rect.y, a, b, rotated)
            right, above = rect.w - a - gap, rect.h - b - gap
            if right > 0:
                free_rects[sid].append(FreeRect(rect.x + a + gap, rect.y, right, b + gap))
            if above > 0:
                free_rects[sid].append(FreeRect(rect.x, rect.y + b + gap, rect.w, above))
        sheets.extend(group_sheets)
    purchased = sum(s.stock.width * s.stock.height for s in sheets)
    return NestResult(
        units=drawing.units,
        sheets=sheets,
        sheet_count=len(sheets),
        net_yield_percent=total_net / purchased * 100,
        blank_yield_percent=total_blank / purchased * 100,
        unused_blank_area=purchased - total_blank,
    )


def _partition(geometry):
    groups = {}
    for g in geometry:
        groups.setdefault((g.part.material.casefold(), dec(g.part.thickness)), []).append(g)
    return groups


def _append(sheet, pid, x, y, a, b, rotated):
    sheet.placements.append(
        Placement(
            part_id=pid, x=float(x), y=float(y), width=float(a), height=float(b), rotated=rotated
        )
    )
