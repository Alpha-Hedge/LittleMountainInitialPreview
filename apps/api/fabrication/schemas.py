from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, model_validator

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10000)]
Key = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")]
Fraction = Annotated[Decimal, Field(ge=0, le=1, max_digits=12, decimal_places=10)]
Object = dict[str, JsonValue]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Citation(Input):
    kind: Literal["historical_job", "nick_rule", "drawing", "template"]
    reference: Text
    excerpt: str = Field(default="", max_length=10000)


class Line(Input):
    line_key: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    work_center_id: UUID | None = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=16000)]
    quantity: int = Field(gt=0, le=2147483647, strict=True)
    entered: Object
    ai_proposed: Object | None
    nick_approved: Object | None
    confidence_score: Fraction | None
    citations: list[Citation] = Field(max_length=200)
    basis: str = Field(default="", max_length=10000)
    override_reason: str = Field(default="", max_length=10000)


class QuoteSnapshot(Input):
    quote_number: Key
    revision: int = Field(gt=0, le=2147483647)
    customer_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    job_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    status: Literal["approved", "sent", "accepted", "declined", "expired"]
    gross_margin_pct: Decimal = Field(ge=0, lt=100, max_digits=8, decimal_places=5)
    drawing_id: UUID | None = None
    pricing_inputs: Object
    lines: list[Line] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def check_lines(self):
        if len({line.line_key for line in self.lines}) != len(self.lines):
            raise ValueError("Line keys must be unique within a quote version.")
        if any(not line.nick_approved for line in self.lines):
            raise ValueError("An approved version requires an approved value for every line.")
        return self


class WorkCenterInput(Input):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    effective_on: date
    hourly_rate: Decimal = Field(ge=0, max_digits=14, decimal_places=4)
    unit: Literal["USD/hour"]
    includes: Text
    default_setup_minutes: Decimal = Field(ge=0, max_digits=10, decimal_places=3)
    efficiency_factor: Decimal = Field(gt=0, max_digits=8, decimal_places=4)


class MaterialInput(Input):
    spec_code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    category: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    supplier: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=180)]
    effective_on: date
    density_lb_per_in3: Decimal = Field(gt=0, max_digits=12, decimal_places=8)
    cost_per_lb: Decimal = Field(ge=0, max_digits=14, decimal_places=4)
    default_scrap_pct: Decimal = Field(ge=0, max_digits=8, decimal_places=4)
    k_factor: Decimal | None = Field(default=None, ge=0, le=1, max_digits=6, decimal_places=5)
    includes: Text

