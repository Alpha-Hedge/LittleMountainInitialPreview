"""Release input. All drawing-space coordinates use the single declared drawing unit."""

from __future__ import annotations

from math import hypot, isclose
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Coordinate = Annotated[float, Field(ge=-1_000_000, le=1_000_000, allow_inf_nan=False)]
Size = Annotated[float, Field(gt=1e-8, le=1_000_000, allow_inf_nan=False)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class Model(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, frozen=True, revalidate_instances="always"
    )


class Point(Model):
    x: Coordinate
    y: Coordinate

    @property
    def xy(self) -> tuple[float, float]:
        return self.x, self.y


class Rectangle(Model):
    kind: Literal["rectangle"]
    width: Size
    height: Size
    corner_radius: Annotated[float, Field(ge=0, le=1_000_000)]

    @model_validator(mode="after")
    def check_radius(self):
        if 0 < self.corner_radius <= 1e-8:
            raise ValueError("The specified radius is below numerical resolution.")
        if self.corner_radius > min(self.width, self.height) / 2:
            raise ValueError("Corner radius exceeds half the shorter side.")
        return self


class PolygonOutline(Model):
    kind: Literal["polygon"]
    vertices: Annotated[list[Point], Field(min_length=3, max_length=256)]


class RoundHole(Model):
    shape: Literal["round"]
    center: Point
    diameter: Size


class Slot(Model):
    shape: Literal["slot"]
    center: Point
    width: Size
    length: Size
    angle: Coordinate

    @model_validator(mode="after")
    def check_slot(self):
        if self.length - self.width <= 1e-8:
            raise ValueError("Slot overall length must exceed its width.")
        return self


class BendLine(Model):
    start: Point
    end: Point
    label: Label = "Bend"
    direction: Literal["up", "down"] | None = None
    angle: Annotated[float, Field(gt=0, le=180)] | None = None


class Dimension(Model):
    label: Label
    start: Point
    end: Point
    axis: Literal["horizontal", "vertical", "aligned"]
    value: Size
    tolerance_plus: Annotated[float, Field(ge=0)] | None = None
    tolerance_minus: Annotated[float, Field(ge=0)] | None = None

    @model_validator(mode="after")
    def check_dimension(self):
        dx, dy = self.end.x - self.start.x, self.end.y - self.start.y
        measured = {"horizontal": abs(dx), "vertical": abs(dy), "aligned": hypot(dx, dy)}[self.axis]
        if not isclose(measured, self.value, rel_tol=1e-10, abs_tol=1e-8):
            raise ValueError(
                f"{self.label}: nominal {self.value:g} conflicts with coordinates ({measured:g})."
            )
        if (self.tolerance_plus is None) != (self.tolerance_minus is None):
            raise ValueError("Enter both sides of the tolerance or leave both unspecified.")
        return self


class Part(Model):
    part_id: Label
    name: Label
    material: Label
    quantity: Annotated[int, Field(gt=0, le=1_000_000_000)]
    thickness: Size
    density_kg_m3: Annotated[float, Field(gt=0, le=100_000)] | None = None
    outline: Annotated[Rectangle | PolygonOutline, Field(discriminator="kind")]
    holes: Annotated[
        list[Annotated[RoundHole | Slot, Field(discriminator="shape")]], Field(max_length=120)
    ] = Field(default_factory=list)
    bends: Annotated[list[BendLine], Field(max_length=120)] = Field(default_factory=list)
    dimensions: Annotated[list[Dimension], Field(max_length=120)] = Field(default_factory=list)
    notes: Annotated[str, Field(max_length=4000)] = ""


class Drawing(Model):
    schema_version: Literal[1] = 1
    title: Label
    revision: Label
    units: Literal["in", "mm"]
    kerf_width: Annotated[float, Field(ge=0, le=1000)] = 0
    parts: Annotated[list[Part], Field(min_length=1, max_length=50)]

    @model_validator(mode="after")
    def unique_identifiers(self):
        if 0 < self.kerf_width <= 2e-8:
            raise ValueError("The specified kerf is below numerical resolution.")
        ids = [part.part_id.casefold() for part in self.parts]
        if len(set(ids)) != len(ids):
            raise ValueError("Every part on a drawing needs a unique part ID.")
        return self
