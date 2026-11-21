"""Deterministic drawing-to-cost calculations. Linear units are inches, currency USD."""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, localcontext
from math import radians, tan
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from packages.costing.engine import allocate, cents, price

from .dxf_compiler import cut_loops
from .geometry import metrics, solve_part
from .nesting import plan_rectangular_batch, plan_stock
from .schema import Part

D = Decimal
Positive = Annotated[Decimal, Field(gt=0, le=1_000_000, allow_inf_nan=False)]
Nonnegative = Annotated[Decimal, Field(ge=0, le=1_000_000, allow_inf_nan=False)]
Fraction = Annotated[Decimal, Field(gt=0, le=1)]
Label = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)
]


class CostInputError(ValueError):
    def __init__(self, issues: list[str]):
        self.issues = issues
        super().__init__(" ".join(issues))


class SettingsModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


class WorkCenter(SettingsModel):
    name: Label
    effective_on: date
    includes: Label
    hourly_rate: Nonnegative
    setup_minutes: Nonnegative
    efficiency_factor: Fraction = D(1)


class MaterialStock(SettingsModel):
    spec_code: Label
    material_family: Label
    material_grade: Label
    thickness_in: Positive
    density_lb_per_in3: Positive
    cost_per_lb: Nonnegative
    k_factor: Annotated[Decimal, Field(ge=0, le=1)]
    supplier: Label
    effective_on: date
    sheet_width_in: Positive
    sheet_height_in: Positive
    margin_in: Nonnegative
    spacing_in: Nonnegative
    allow_rotate: bool

    def match_key(self):
        return (
            self.material_family.casefold(),
            self.material_grade.casefold(),
            self.thickness_in,
        )


class CutSettings(SettingsModel):
    center: WorkCenter
    kerf_in: Nonnegative
    speed_in_min: Positive
    seconds_per_pierce: Nonnegative


class BrakeSettings(SettingsModel):
    center: WorkCenter
    seconds_per_bend: Positive


class WeldSettings(SettingsModel):
    process: Literal["GMAW", "GTAW", "FCAW", "SMAW"]
    material_family: Label
    center: WorkCenter
    filler_density_lb_per_in3: Positive
    deposit_lb_per_arc_hour: Positive
    deposition_efficiency: Fraction
    arc_on_fraction: Fraction
    position_factors: dict[Label, Positive]
    filler_usd_per_lb: Nonnegative
    gas_flow_scfh: Nonnegative
    gas_seconds_per_start: Nonnegative
    gas_usd_per_scf: Nonnegative

    @model_validator(mode="after")
    def check_process(self):
        if not self.position_factors:
            raise ValueError(
                "Supply a deposition factor for each supported weld position."
            )
        if self.process == "SMAW" and self.gas_flow_scfh:
            raise ValueError(
                "SMAW uses flux shielding and cannot consume external shielding gas."
            )
        if self.process in ("GTAW", "GMAW") and not self.gas_flow_scfh:
            raise ValueError(
                "Enter a shielding gas flow for the selected gas-shielded process."
            )
        return self


class ScopeAllowance(SettingsModel):
    part_id: Label
    requirement: str = Field(min_length=1, max_length=600)
    description: Label
    amount: Nonnegative
    rate: Nonnegative
    basis: Literal["batch", "per_unit"]
    source: Label
    unit: Label = "allowance"
    effective_on: date | None = None


class CostSettings(SettingsModel):
    snapshot_name: Label
    demo: bool
    gross_margin_pct: Annotated[Decimal, Field(ge=0, lt=100, max_digits=6, decimal_places=4)]
    materials: Annotated[list[MaterialStock], Field(min_length=1)]
    cut: CutSettings
    brake: BrakeSettings
    welds: list[WeldSettings]
    allowances: list[ScopeAllowance] = Field(default_factory=list)

    @model_validator(mode="after")
    def distinct_settings(self):
        material_keys = [m.match_key() for m in self.materials]
        weld_keys = [(w.process, w.material_family.casefold()) for w in self.welds]
        if len(set(material_keys)) != len(material_keys) or len(set(weld_keys)) != len(
            weld_keys
        ):
            raise ValueError(
                "Select one material price and one weld schedule per matching key."
            )
        return self


def demo_settings() -> CostSettings:
    from pathlib import Path

    return CostSettings.model_validate_json(
        Path(__file__)
        .with_name("demo_cost_settings.json")
        .read_text(encoding="utf-8-sig")
    )


def benchmark_demo_settings() -> CostSettings:
    example = demo_settings().model_dump(mode="json")
    example["snapshot_name"] = "U.S. shop benchmarks · Demo"
    # Match the A36, MIG, plasma and brake allowances in the dated U.S. practice rate book.
    effective_on = "2026-11-20"
    example["materials"][0].update(
        cost_per_lb="2.55",
        supplier="U.S. practice allowance based on Online Metals retail plate listings",
        effective_on=effective_on,
    )
    for operation in (example["cut"], example["brake"]):
        operation["center"].update(
            hourly_rate="85", effective_on=effective_on,
            includes="Machine, operator and standard tooling. Special consumables separate.",
        )
    for weld in example["welds"]:
        weld["center"].update(
            hourly_rate="75", effective_on=effective_on,
            includes="Operator, machine and shop overhead. Filler and gas priced separately.",
        )
    return CostSettings.model_validate(example)


def dec(value):
    return D(str(value))


def measure(value):
    return format(
        dec(value).quantize(D("0.0000000001"), ROUND_HALF_UP).normalize(), "f"
    )


def dollars(value):
    return format(cents(dec(value)), ".2f")


def required(value, description):
    if value is None:
        raise ValueError(f"Confirm {description}.")
    return value


def add_row(
    line,
    category,
    stage,
    label,
    amount,
    rate,
    basis_text,
    source,
    *,
    unit,
    includes,
    effective_on,
    center=None,
):
    rows = line["rows"]
    rows.append(
        {
            "id": f"{line['part_id']}/{category}/{len(rows) + 1}",
            "label": label,
            "category": category,
            "stage": stage,
            "work_center": center,
            "basis": "batch",
            "amount": measure(amount),
            "rate": format(dec(rate), "f"),
            "unit": unit,
            "includes": includes,
            "rate_source": source,
            "rate_effective_on": effective_on.isoformat()
            if effective_on is not None
            else None,
            "basis_text": basis_text,
            "citations": [source],
        }
    )


def center_row(line, category, stage, center, hours, text):
    add_row(
        line,
        category,
        stage,
        f"{center.name} {stage}",
        hours,
        center.hourly_rate,
        text,
        f"{center.name}, effective {center.effective_on}; {center.includes}",
        center=center.name,
        unit="hours",
        includes=center.includes,
        effective_on=center.effective_on,
    )


def bend_geometry(bend, stock):
    angle = required(bend.angle_deg, "the bend-through angle")
    if not 0 < angle < 180:
        raise ValueError("Hems and return bends need a measured shop deduction.")
    rad = dec(required(bend.inside_radius_in, "the inside bend radius"))
    theta = radians(angle)
    allowance = dec(theta) * (rad + stock.k_factor * stock.thickness_in)
    setback = (rad + stock.thickness_in) * dec(tan(theta / 2))
    return allowance, 2 * setback - allowance


def flat_geometry(part, stock, bend_deduction):
    outline = required(part.outline, "flat outline")
    if outline.kind == "rectangle":
        width = dec(required(outline.width_in, "blank width"))
        height = dec(required(outline.height_in, "blank height"))
        if part.dimension_basis == "outside_flange_sum":
            axis = getattr(part, "development_axis", None)
            if axis not in ("width", "height") or part.holes:
                raise ValueError(
                    "Confirm the flat blank and hole locations, or identify a single development axis for an unpierced rectangle."
                )
            if axis == "width":
                width -= bend_deduction
            else:
                height -= bend_deduction
        profile = {
            "kind": "rectangle",
            "width": float(width),
            "height": float(height),
            "corner_radius": float(
                required(
                    outline.corner_radius_in, "corner radius (zero for square corners)"
                )
            ),
        }
    elif outline.kind == "polygon" and part.dimension_basis != "outside_flange_sum":
        profile = {
            "kind": "polygon",
            "vertices": [v.model_dump() for v in outline.vertices],
        }
    else:
        raise ValueError("Supply a dimensioned flat profile for nesting.")
    if part.bends and part.dimension_basis not in ("flat", "outside_flange_sum"):
        raise ValueError(
            "Confirm whether dimensions describe the flat blank or outside flanges."
        )
    holes = []
    for hole in part.holes:
        if hole.cutting_method != "cut":
            raise ValueError(
                "Confirm the through-cut method or quote the drilled feature separately."
            )
        if hole.count != 1:
            raise ValueError(
                "Supply a center for every opening in the repeated hole group."
            )
        center = {
            "x": required(hole.center_x_in, "hole center X"),
            "y": required(hole.center_y_in, "hole center Y"),
        }
        if hole.shape == "round":
            holes.append(
                {
                    "shape": "round",
                    "center": center,
                    "diameter": required(hole.diameter_in, "hole diameter"),
                }
            )
        elif hole.shape == "slot":
            holes.append(
                {
                    "shape": "slot",
                    "center": center,
                    "length": required(hole.length_in, "slot length"),
                    "width": required(hole.width_in, "slot width"),
                    "angle": required(hole.angle_deg, "slot angle"),
                }
            )
        else:
            raise ValueError("Confirm the shape and dimensions of the opening.")
    return solve_part(
        Part.model_validate(
            {
                "part_id": part.part_id,
                "name": part.description or part.part_id,
                "material": stock.spec_code,
                "quantity": part.quantity,
                "thickness": float(stock.thickness_in),
                "outline": profile,
                "holes": holes,
            }
        )
    )


def weld_usage(weld, schedule, qty):
    span = dec(required(weld.length_in, "the weld seam length"))
    repeats = (
        required(weld.count, "the number of welds")
        * required(weld.sides, "the number of welded sides")
        * qty
    )
    stitches = 1
    if (
        weld.increment_in is not None
        or weld.pitch_in is not None
        or getattr(weld, "stitches_per_side", None)
    ):
        segment = dec(required(weld.increment_in, "intermittent weld increment"))
        pitch = dec(required(weld.pitch_in, "intermittent weld center-to-center pitch"))
        if segment > pitch or segment > span:
            raise ValueError(
                "Stitch length exceeds the seam span or center-to-center pitch."
            )
        count = getattr(weld, "stitches_per_side", None)
        if count is None:
            intervals = (span - segment) / pitch
            if intervals != int(intervals):
                raise ValueError(
                    "Confirm the number of stitches per side; the seam ends are ambiguous."
                )
            count = int(intervals) + 1
        if (count - 1) * pitch + segment > span:
            raise ValueError("Specified stitch count does not fit the weld span.")
        stitches, span = count, count * segment
    area = getattr(weld, "cross_section_area_in2", None)
    if area is not None:
        area = dec(area)
    elif weld.joint_type == "fillet":
        area = dec(required(weld.size_in, "the equal fillet leg dimension")) ** 2 / 2
    else:
        raise ValueError(
            "Supply the deposited cross-sectional area from the groove/joint detail."
        )
    factor = schedule.position_factors.get(weld.position or "")
    if factor is None:
        raise ValueError(
            f"Configure a {schedule.process} deposition factor for position {weld.position!r}."
        )
    length = span * repeats
    starts = stitches * repeats
    deposited = length * area * schedule.filler_density_lb_per_in3
    arc = deposited / (schedule.deposit_lb_per_arc_hour * factor)
    gas = schedule.gas_flow_scfh * (
        arc + starts * schedule.gas_seconds_per_start / 3600
    )
    return {
        "welded_length_in": length,
        "starts": starts,
        "deposit_area_in2": area,
        "deposited_lb": deposited,
        "filler_lb": deposited / schedule.deposition_efficiency,
        "gas_scf": gas,
        "arc_hours": arc,
        "run_hours": arc / schedule.arc_on_fraction / schedule.center.efficiency_factor,
    }


def reprice_result(result):
    result = deepcopy(result)
    parts = result["lines"]
    draft = {
        "marginPercent": result["gross_margin_pct"],
        "items": [
            {"id": p["part_id"], "quantity": p["quantity"], "costRows": p["rows"]}
            for p in parts
        ],
    }
    priced = price(draft)
    sales = allocate(priced["sellingPrice"], [p["cost"] for p in priced["items"]])
    center_hours = defaultdict(lambda: {"setup": D(0), "run": D(0)})
    for line, totals, sale in zip(parts, priced["items"], sales, strict=True):
        for row, priced_row in zip(line["rows"], totals["rows"], strict=True):
            row["cost_usd"] = dollars(priced_row["cost"])
            if row["work_center"]:
                units = line["quantity"] if row["basis"] == "per_unit" else 1
                center_hours[row["work_center"]][row["stage"]] += (
                    dec(row["amount"]) * units
                )
        line["estimated_cost_usd"] = dollars(totals["cost"])
        line["selling_price_usd"] = dollars(sale)
    result["hours_by_work_center"] = [
        {
            "work_center": name,
            "setup_hours": measure(hours["setup"]),
            "run_hours": measure(hours["run"]),
            "total_hours": measure(sum(hours.values())),
        }
        for name, hours in center_hours.items()
    ]
    result["estimated_cost_usd"] = dollars(priced["estimatedCost"])
    result["selling_price_usd"] = dollars(priced["sellingPrice"])
    result["totals"] = {
        k: result[k]
        for k in ("estimated_cost_usd", "selling_price_usd", "gross_margin_pct")
    }
    return result


def cost_part(part, stock, settings, schedules, charged):
    qty = required(part.quantity, "piece quantity")
    cut, brake = settings.cut, settings.brake
    bend_data = []
    deduction = D(0)
    for b in part.bends:
        allowance, bd = bend_geometry(b, stock)
        deduction += bd * b.count
        bend_data.append(
            {
                "bend_through_deg": b.angle_deg,
                "inside_radius_in": b.inside_radius_in,
                "count_per_piece": b.count,
                "k_factor": measure(stock.k_factor),
                "allowance_in": measure(allowance),
                "deduction_in": measure(bd),
                "tool_id": b.tool_id,
            }
        )
    geom = flat_geometry(part, stock, deduction)
    paths = cut_loops(geom, float(cut.kerf_in))
    cut_in = sum((dec(metrics(loop)[1]) for _, loop in paths), D(0)) * qty
    pierces = len(paths) * qty
    cut_hours = (
        cut_in / cut.speed_in_min / 60 + pierces * cut.seconds_per_pierce / 3600
    ) / cut.center.efficiency_factor
    weight = dec(geom.net_area) * stock.thickness_in * stock.density_lb_per_in3
    line = {
        "part_id": part.part_id,
        "description": part.description,
        "quantity": qty,
        "weight_lb": measure(weight),
        "material_family": stock.material_family,
        "processes": ["CUT"],
        "rows": [],
        "metrics": {
            "net_area_in2_each": measure(geom.net_area),
            "flat_width_in": measure(geom.bounds[2] - geom.bounds[0]),
            "flat_height_in": measure(geom.bounds[3] - geom.bounds[1]),
            "net_weight_lb_each": measure(weight),
            "kerf_path_in": measure(cut_in),
            "kerf_width_in": measure(cut.kerf_in),
            "pierces": pierces,
            "bend_deduction_in_each": measure(deduction),
            "bends": bend_data,
            "welds": [],
        },
    }

    # Setup belongs to the first line using each distinct batch setting.
    def setup(category, center, key, text):
        if key not in charged:
            center_row(line, category, "setup", center, center.setup_minutes / 60, text)
            charged.add(key)

    setup(
        "cut",
        cut.center,
        ("cut", stock.match_key()),
        f"One {cut.center.setup_minutes} min setup for this stock and thickness.",
    )
    center_row(
        line,
        "cut",
        "run",
        cut.center,
        cut_hours,
        f"{measure(cut_in)} in at {cut.speed_in_min} in/min; {pierces} pierces at {cut.seconds_per_pierce} s; efficiency {cut.center.efficiency_factor}.",
    )
    if part.bends:
        line["processes"].append("BEND")
        hits = sum(b.count for b in part.bends) * qty
        for b in part.bends:
            # A missing tool ID groups only identical radius/angle demands on the same material.
            tool = b.tool_id or f"inside radius {b.inside_radius_in} in"
            setup(
                "bend",
                brake.center,
                ("brake", stock.match_key(), b.angle_deg, tool),
                f"One {brake.center.setup_minutes} min setup for {b.angle_deg} deg, {tool}, {stock.spec_code}.",
            )
        center_row(
            line,
            "bend",
            "run",
            brake.center,
            hits * brake.seconds_per_bend / 3600 / brake.center.efficiency_factor,
            f"{hits} bends at {brake.seconds_per_bend} seconds per hit; efficiency {brake.center.efficiency_factor}.",
        )
    for weld in part.welds:
        schedule = schedules.get((weld.process, stock.material_family.casefold()))
        if schedule is None:
            raise ValueError(
                f"Configure the {weld.process} welding schedule for {stock.material_family}."
            )
        use = weld_usage(weld, schedule, qty)
        line["metrics"]["welds"].append(
            {
                "process": weld.process,
                "position": weld.position,
                **{
                    key: (value if key == "starts" else measure(value))
                    for key, value in use.items()
                },
            }
        )
        if weld.process not in line["processes"]:
            line["processes"].append(weld.process)
        c = schedule.center
        setup(
            "weld",
            c,
            ("weld", weld.process, stock.match_key()),
            f"One {c.setup_minutes} min {weld.process} batch setup for {stock.spec_code}.",
        )
        center_row(
            line,
            "weld",
            "run",
            c,
            use["run_hours"],
            f"{measure(use['deposited_lb'])} lb deposited over {measure(use['welded_length_in'])} in; "
            f"{schedule.deposit_lb_per_arc_hour} lb/arc h × {schedule.position_factors[weld.position]} for {weld.position}; "
            f"arc-on fraction {schedule.arc_on_fraction}; efficiency {c.efficiency_factor}.",
        )
        source = f"{weld.process} shop schedule, {c.name}, effective {c.effective_on}"
        add_row(
            line,
            "filler",
            "consumable",
            f"{weld.process} filler (lb)",
            use["filler_lb"],
            schedule.filler_usd_per_lb,
            f"Deposited pounds / {schedule.deposition_efficiency} deposition efficiency.",
            source,
            unit="lb",
            includes=f"Purchased {weld.process} filler including deposition losses",
            effective_on=c.effective_on,
        )
        if schedule.gas_flow_scfh:
            add_row(
                line,
                "gas",
                "consumable",
                f"{weld.process} shielding gas (scf)",
                use["gas_scf"],
                schedule.gas_usd_per_scf,
                f"{schedule.gas_flow_scfh} scfh during arc time plus {schedule.gas_seconds_per_start} s for each of {use['starts']} starts.",
                source,
                unit="scf",
                includes="Shielding gas during arc time and configured start/stop flow",
                effective_on=c.effective_on,
            )
    extras = [a for a in settings.allowances if a.part_id == part.part_id]
    covered = {a.requirement for a in extras}
    for requirement in [*part.requirements, *([part.finish] if part.finish else [])]:
        if requirement not in covered:
            raise ValueError(
                f"Add a priced allowance or confirmed included allowance for '{requirement}'."
            )
    for a in extras:
        add_row(
            line,
            "allowance",
            "run",
            a.description,
            a.amount,
            a.rate,
            a.requirement,
            a.source,
            unit=a.unit,
            includes=a.requirement,
            effective_on=a.effective_on,
        )
        line["rows"][-1]["basis"] = a.basis
    return line, geom


def allocate_sheet_cost(total, weights):
    """Allocate each purchased-stock cent in proportion to occupied rectangular blank area."""
    total_cents = int(cents(total) * 100)
    shares = [w * total_cents / sum(weights) for w in weights]
    result = [int(s) for s in shares]
    order = sorted(range(len(weights)), key=lambda i: -(shares[i] - result[i]))
    for i in order[: total_cents - sum(result)]:
        result[i] += 1
    return [D(value) / 100 for value in result]


def nested_group(entries, stock, cut):
    lines, geoms = zip(*entries, strict=True)
    kerf = cut.kerf_in
    parts = [g.part for g in geoms]
    if sum(p.quantity for p in parts) > 1000 and len(parts) == 1:
        g = geoms[0]
        plan = plan_rectangular_batch(
            stock.sheet_width_in,
            stock.sheet_height_in,
            g.bounds[2] - g.bounds[0],
            g.bounds[3] - g.bounds[1],
            stock.margin_in + kerf,
            stock.spacing_in + 2 * kerf,
            stock.allow_rotate,
            g.part.quantity,
        )
        sheets = plan["sheet_count"]
    else:
        packed = plan_stock(
            {
                "drawing": {
                    "title": "Costed blanks",
                    "revision": "Estimate",
                    "units": "in",
                    "kerf_width": float(kerf),
                    "parts": [p.model_dump() for p in parts],
                },
                "stock": [
                    {
                        "material": stock.spec_code,
                        "thickness": float(stock.thickness_in),
                        "width": float(stock.sheet_width_in),
                        "height": float(stock.sheet_height_in),
                        "margin": float(stock.margin_in),
                        "spacing": float(stock.spacing_in),
                        "allow_rotate": stock.allow_rotate,
                    }
                ],
            }
        )
        sheets = packed.sheet_count
    blank_areas = [
        dec(g.bounds[2] - g.bounds[0])
        * dec(g.bounds[3] - g.bounds[1])
        * g.part.quantity
        for g in geoms
    ]
    net = sum(dec(g.net_area) * g.part.quantity for g in geoms)
    gross = sheets * stock.sheet_width_in * stock.sheet_height_in
    weight = gross * stock.thickness_in * stock.density_lb_per_in3
    total = cents(weight * stock.cost_per_lb)
    for line, cost in zip(lines, allocate_sheet_cost(total, blank_areas), strict=True):
        add_row(
            line,
            "material",
            "stock",
            f"{stock.spec_code} sheet allocation",
            1,
            cost,
            f"{sheets} sheet(s), {measure(weight)} lb at USD {stock.cost_per_lb}/lb; allocated by batch blank area.",
            f"{stock.spec_code}, {stock.supplier}, effective {stock.effective_on}",
            unit="stock allocation",
            includes="Allocated share of purchased sheets, including unused stock",
            effective_on=stock.effective_on,
        )
    return {
        "spec_code": stock.spec_code,
        "sheet_count": sheets,
        "part_ids": [p.part_id for p in parts],
        "gross_area_in2": measure(gross),
        "net_area_in2": measure(net),
        "purchased_weight_lb": measure(weight),
        "net_yield_pct": measure(100 * net / gross),
        "blank_yield_pct": measure(100 * sum(blank_areas) / gross),
        "scrap_pct": measure(100 * (gross - net) / gross),
        "stock_cost_usd": dollars(total),
    }


def calculate_cost(
    ast, settings, *, accepted_low_confidence: frozenset[str] = frozenset()
):
    """Price a confirmed AST with a frozen rate card. No partial totals on a review failure."""
    from packages.ai.schemas import EngineeringAST

    ast = EngineeringAST.model_validate(ast)
    settings = CostSettings.model_validate(settings)
    issues = [
        f"{flag.path}: {flag.reason}"
        for flag in ast.review_flags()
        if flag.blocks_pricing
        and not (flag.kind == "low_confidence" and flag.path in accepted_low_confidence)
    ]
    if issues:
        raise CostInputError(issues)
    stocks = {s.match_key(): s for s in settings.materials}
    schedules = {(s.process, s.material_family.casefold()): s for s in settings.welds}
    lines, charged, groups = [], set(), defaultdict(list)
    with localcontext() as ctx:
        ctx.prec = 48
        unused = {a.part_id for a in settings.allowances} - {
            p.part_id for p in ast.parts
        }
        if unused:
            issues.append(
                f"Unknown part IDs in scope allowances: {', '.join(sorted(unused))}."
            )
        for part in ast.parts:
            key = (
                part.material_family.casefold(),
                part.material_grade.casefold(),
                dec(part.thickness_in),
            )
            try:
                if key not in stocks:
                    raise ValueError(
                        f"Select dated stock for {part.material_family}, {part.material_grade}, {part.thickness_in} in."
                    )
                line, geometry = cost_part(
                    part, stocks[key], settings, schedules, charged
                )
                lines.append(line)
                groups[key].append((line, geometry))
            except ValueError as exc:
                issues.append(f"{part.part_id}: {exc}")
        if issues:
            raise CostInputError(issues)
        stock_groups = []
        for key, entries in groups.items():
            try:
                stock_groups.append(nested_group(entries, stocks[key], settings.cut))
            except ValueError as exc:
                issues.append(f"{stocks[key].spec_code}: {exc}")
        if issues:
            raise CostInputError(issues)
        return reprice_result(
            {
                "gross_margin_pct": measure(settings.gross_margin_pct),
                "lines": lines,
                "stock_groups": stock_groups,
                "settings": settings.model_dump(mode="json"),
            }
        )
