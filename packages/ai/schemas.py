"""Evidence-bearing fabrication requirements. All linear quantities use inches."""

from __future__ import annotations

from math import isclose
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


class StrictNode(BaseModel):
    model_config = ConfigDict(
        strict=True, extra="forbid", allow_inf_nan=False, validate_default=True
    )


Text = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)
]
Identifier = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)
]
Length = Annotated[float, Field(gt=0, le=1_000_000)]
Coordinate = Annotated[float, Field(ge=-1_000_000, le=1_000_000)]
Nonnegative = Annotated[float, Field(ge=0, le=1_000_000)]
Count = Annotated[int, Field(ge=1, le=1_000_000)]
Score = Annotated[float, Field(ge=0, le=1)]
REVIEW_THRESHOLD = 0.85


class Evidence(StrictNode):
    source: Literal["pdf", "dxf", "notes", "review"]
    page: Annotated[int, Field(ge=1, le=1000)] | None = None
    handle: Identifier | None = None
    excerpt: Text
    fields: Annotated[list[Identifier], Field(min_length=1, max_length=25)]

    @model_validator(mode="after")
    def location(self):
        if (self.source == "pdf") != (self.page is not None):
            raise ValueError("A PDF citation needs its original page number.")
        if (self.source == "dxf") != (self.handle is not None):
            raise ValueError("A DXF citation needs its original entity handle.")
        return self


class ReviewFlag(StrictNode):
    path: str
    kind: Literal[
        "low_confidence", "missing", "conflict", "unsupported", "unverified_source"
    ]
    reason: str

    @property
    def blocks_pricing(self) -> bool:
        # The display name does not enter shop costing. Geometry and requirements still do.
        return not (self.kind == "unverified_source" and self.path.endswith(".description"))


class PageLocation(StrictNode):
    """Image registration only. Neither value is a manufacturing measurement."""
    page: Annotated[int, Field(ge=1, le=1000)]
    x: Annotated[float, Field(ge=0, le=1000)]
    y: Annotated[float, Field(ge=0, le=1000)]


class FieldLocation(StrictNode):
    field: Identifier
    location: PageLocation


class PageFrame(StrictNode):
    cad_bounds_in: Annotated[list[Coordinate], Field(min_length=4,max_length=4)] | None = None
    lower_left: PageLocation
    lower_right: PageLocation
    upper_left: PageLocation

    @model_validator(mode="after")
    def consistent(self):
        a,b,c=self.lower_left,self.lower_right,self.upper_left
        if len({a.page,b.page,c.page})!=1 or abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)) < 1:
            raise ValueError("Choose three distinct corners on the same view.")
        return self


class PartFeature(StrictNode):
    page_anchor: PageLocation | None = None
    field_locations: Annotated[list[FieldLocation], Field(max_length=48)] = Field(default_factory=list)
    confidence: Score
    evidence: Annotated[list[Evidence], Field(max_length=32)] = Field(
        default_factory=list
    )
    issues: Annotated[list[Text], Field(max_length=32)] = Field(default_factory=list)


class Point(StrictNode):
    x: Coordinate
    y: Coordinate


class Outline(PartFeature):
    kind: Literal["rectangle", "polygon", "unknown"]
    width_in: Length | None = None
    height_in: Length | None = None
    corner_radius_in: Nonnegative | None = None
    vertices: Annotated[list[Point], Field(max_length=256)] = Field(
        default_factory=list
    )


class HoleSpec(PartFeature):
    shape: Literal["round", "slot", "unknown"]
    cutting_method: Literal["cut", "drill", "unknown"]
    center_x_in: Coordinate | None = None
    center_y_in: Coordinate | None = None
    diameter_in: Length | None = None
    length_in: Length | None = None
    width_in: Length | None = None
    angle_deg: Annotated[float, Field(ge=-360, le=360)] | None = None
    count: Count = 1


class BendSpec(PartFeature):
    start_in: Point | None = None
    end_in: Point | None = None
    tool_id: Identifier | None = None
    angle_deg: Annotated[float, Field(gt=0, lt=180)] | None = None
    inside_radius_in: Nonnegative | None = None
    length_in: Length | None = None
    count: Count = 1


class WeldCallout(PartFeature):
    all_around: bool | None = None
    field_weld: bool | None = None
    cross_section_area_in2: Length | None = None
    stitches_per_side: Count | None = None
    process: Literal["GMAW", "GTAW", "FCAW", "SMAW"] | None = None
    joint_type: Literal["fillet", "groove", "plug", "slot", "other"] | None = None
    joint_configuration: (
        Literal["butt", "tee", "lap", "corner", "edge", "other"] | None
    ) = None
    size_in: Length | None = None
    length_in: Length | None = None
    increment_in: Length | None = None
    pitch_in: Length | None = None
    position: (
        Literal["1F", "2F", "3F", "4F", "1G", "2G", "3G", "4G", "5G", "6G"] | None
    ) = None
    count: Count = 1
    sides: Literal[1, 2] | None = None


class EngineeringPart(PartFeature):
    page_frame: PageFrame | None = None
    part_id: Identifier
    description: Text | None = None
    material_family: Text | None = None
    material_grade: Text | None = None
    stock_form: Literal["plate", "sheet", "tube", "angle", "channel", "beam", "bar", "pipe", "assembly", "other"] | None = None
    section_designation: Text | None = None
    gauge_designation: Text | None = None
    quantity: Count | None = None
    thickness_in: Length | None = None
    dimension_basis: Literal["flat", "outside_flange_sum", "unknown"] = "unknown"
    development_axis: Literal["width", "height"] | None = None
    outline: Outline
    holes: Annotated[list[HoleSpec], Field(max_length=120)] = Field(
        default_factory=list
    )
    bends: Annotated[list[BendSpec], Field(max_length=120)] = Field(
        default_factory=list
    )
    welds: Annotated[list[WeldCallout], Field(max_length=120)] = Field(
        default_factory=list
    )
    finish: Text | None = None
    requirements: Annotated[list[Text], Field(max_length=40)] = Field(
        default_factory=list
    )


class EngineeringAST(StrictNode):
    drawing_revision: Identifier | None = None
    # The historical field name is retained for older saved drawings. It records a source note.
    source_release_hold: Text | None = None
    source_units: Literal["in", "mm", "mixed", "unknown"] = "unknown"
    parts: Annotated[list[EngineeringPart], Field(max_length=50)]
    issues: Annotated[list[Text], Field(max_length=40)] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_parts(self):
        ids = [p.part_id.casefold() for p in self.parts]
        if len(ids) != len(set(ids)):
            raise ValueError("Part identifiers must be unique.")
        return self

    def review_flags(self) -> list[ReviewFlag]:
        flags: list[ReviewFlag] = []

        def flag(path, kind, reason):
            flags.append(ReviewFlag(path=path, kind=kind, reason=reason))

        def feature(item: PartFeature, path: str, required):
            if item.confidence < REVIEW_THRESHOLD:
                flag(
                    path,
                    "low_confidence",
                    f"Reported confidence {item.confidence} is below 0.85.",
                )
            for issue in item.issues:
                flag(
                    path,
                    "unverified_source"
                    if issue.startswith("Unverified source")
                    else "conflict",
                    issue,
                )
            cited = {field for e in item.evidence for field in e.fields}
            for name in required:
                value = getattr(item, name)
                if value is None or value == "unknown" or value == []:
                    flag(
                        f"{path}.{name}",
                        "missing",
                        f"Confirm {name.replace('_', ' ')}.",
                    )
                elif name not in cited:
                    flag(
                        f"{path}.{name}",
                        "unverified_source",
                        "Supply a source or review note for this value.",
                    )

        if not self.parts:
            flag("parts", "missing", "Identify the parts to quote.")
        if self.source_units == "unknown":
            flag("source_units", "missing", "Confirm the drawing units.")
        for issue in self.issues:
            flag("drawing", "conflict", issue)
        for n, part in enumerate(self.parts):
            path = f"parts.{n}"
            flat_stock = part.stock_form in (None, "plate", "sheet")
            fields = [
                "quantity",
                "material_family",
                "material_grade",
                "description",
            ]
            if flat_stock:
                fields += ["thickness_in", "dimension_basis"]
            elif part.thickness_in is not None:
                fields.append("thickness_in")
            if flat_stock and part.dimension_basis == "outside_flange_sum":
                fields.append("development_axis")
            fields += [name for name in ("stock_form", "section_designation", "gauge_designation") if getattr(part, name)]
            if not flat_stock:
                flag(path + ".stock_form", "unsupported",
                     "Quote this section or assembly as a separate manual operation. Sheet nesting applies to flat stock.")
            fields += [
                name for name in ("finish", "requirements") if getattr(part, name)
            ]
            feature(part, path, fields)
            outline = part.outline
            fields = ["kind"]
            if outline.kind == "rectangle":
                fields += ["width_in", "height_in", "corner_radius_in"]
                if outline.vertices:
                    flag(
                        path + ".outline",
                        "conflict",
                        "Both a rectangle and polygon vertices were supplied. Confirm the intended outer profile.",
                    )
            elif outline.kind == "polygon":
                fields += ["vertices"]
                if outline.corner_radius_in:
                    flag(
                        path + ".outline",
                        "unsupported",
                        "Confirm the curved corners on this straight-sided polygon.",
                    )
                if outline.vertices:
                    for dim, axis in (("width_in", "x"), ("height_in", "y")):
                        span = getattr(outline, dim)
                        coords = [getattr(v, axis) for v in outline.vertices]
                        if span is not None and not isclose(
                            span, max(coords) - min(coords), abs_tol=1e-6
                        ):
                            flag(
                                path + ".outline." + dim,
                                "conflict",
                                "The written span disagrees with the polygon vertices.",
                            )
                if 0 < len(outline.vertices) < 3:
                    flag(
                        path + ".outline.vertices",
                        "missing",
                        "A polygon needs at least three vertices.",
                    )
            if flat_stock or outline.kind != "unknown":
                feature(outline, path + ".outline", fields)

            def required_for_quote(item, fields):
                return fields if flat_stock else [name for name in fields if getattr(item, name) not in (None, "unknown")]
            for i, hole in enumerate(part.holes):
                hp = f"{path}.holes.{i}"
                fields = ["shape", "cutting_method", "center_x_in", "center_y_in"]
                if hole.shape == "round":
                    fields += ["diameter_in"]
                    if any(
                        x is not None and x != hole.diameter_in
                        for x in (hole.length_in, hole.width_in)
                    ):
                        flag(
                            hp,
                            "conflict",
                            "The opening is called round but its other written dimensions disagree with its diameter.",
                        )
                if hole.shape == "slot":
                    fields += ["length_in", "width_in", "angle_deg"]
                    if (
                        hole.diameter_in is not None
                        and hole.diameter_in != hole.width_in
                    ):
                        flag(
                            hp,
                            "conflict",
                            "The slot end diameter disagrees with its width.",
                        )
                if hole.count > 1:
                    flag(
                        hp + ".count",
                        "missing",
                        "Provide a separate center for each opening.",
                    )
                feature(hole, hp, required_for_quote(hole, fields))
            for i, bend in enumerate(part.bends):
                fields = ["angle_deg", "length_in", "inside_radius_in"]
                if bend.tool_id is not None:
                    fields.append("tool_id")
                if bend.count > 1:
                    fields.append("count")
                feature(bend, f"{path}.bends.{i}", required_for_quote(bend, fields))
            for i, weld in enumerate(part.welds):
                wp = f"{path}.welds.{i}"
                fields = ["process", "joint_type", "length_in", "position", "sides"]
                fields += [name for name in ("all_around", "field_weld") if getattr(weld, name) is not None]
                if weld.field_weld:
                    flag(wp + ".field_weld", "unsupported", "Confirm site labor and equipment for this field weld in a manual quote.")
                if weld.joint_configuration is not None:
                    fields.append("joint_configuration")
                if (
                    weld.joint_type == "fillet"
                    or weld.cross_section_area_in2 is None
                    or weld.size_in is not None
                ):
                    fields.append("size_in")
                if weld.cross_section_area_in2 is not None or weld.joint_type not in (
                    None,
                    "fillet",
                ):
                    fields.append("cross_section_area_in2")
                if weld.stitches_per_side is not None:
                    fields.append("stitches_per_side")
                if weld.count > 1:
                    fields.append("count")
                if weld.pitch_in is not None or weld.increment_in is not None:
                    fields += ["pitch_in", "increment_in"]
                    if (
                        weld.pitch_in is not None
                        and weld.increment_in is not None
                        and weld.increment_in > weld.pitch_in
                    ):
                        flag(
                            wp,
                            "conflict",
                            "Intermittent weld increment exceeds its center-to-center pitch.",
                        )
                feature(weld, wp, required_for_quote(weld, fields))
        return flags
