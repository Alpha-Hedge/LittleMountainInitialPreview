"""Deterministic, shop-supplied stock and work-center allowances in mm, hours and USD."""
import json
import sys
from decimal import Decimal, DecimalException, ROUND_HALF_UP
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError

from packages.cad.nesting import plan_rectangular_batch
from .engine import price


class Inputs(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


Positive = Annotated[Decimal, Field(gt=0, le=1_000_000_000, decimal_places=4)]
Nonnegative = Annotated[Decimal, Field(ge=0, le=1_000_000_000, decimal_places=4)]


class Stock(Inputs):
    width: Positive
    height: Positive
    blankWidth: Positive
    blankHeight: Positive
    margin: Nonnegative
    gap: Nonnegative
    sheetCost: Nonnegative
    allowRotation: StrictBool


class Work(Inputs):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    unit: Literal["mm cut", "bend", "mm weld", "piece"]
    unitsPerPiece: Nonnegative
    unitsPerHour: Positive
    setupMinutes: Nonnegative
    hourlyRate: Nonnegative
    efficiencyFactor: Positive = Decimal(1)


class Routing(Inputs):
    quantity: Annotated[StrictInt, Field(ge=1, le=1_000_000_000)]
    stock: Stock
    operations: Annotated[list[Work], Field(max_length=100)]


def estimate(inputs: Routing):
    stock = inputs.stock
    layout = plan_rectangular_batch(
        float(stock.width), float(stock.height), float(stock.blankWidth), float(stock.blankHeight),
        float(stock.margin), float(stock.gap), stock.allowRotation, inputs.quantity,
    )
    sheet_count = layout["sheet_count"]
    rows = [{"label": "Sheet stock", "amount": sheet_count, "rate": float(stock.sheetCost), "basis": "batch"}]
    hours = []
    for work in inputs.operations:
        name = work.name.strip()
        if not name:
            raise ValueError("Enter a name for each work center.")
        setup = work.setupMinutes / 60
        run = Decimal(inputs.quantity) * work.unitsPerPiece / (work.unitsPerHour * work.efficiencyFactor)
        allowance = (setup + run).quantize(Decimal(".0001"), rounding=ROUND_HALF_UP)
        if allowance > 1_000_000_000:
            raise ValueError("This work allowance exceeds the supported hours.")
        hours.append({"name": name, "setupHours": float(setup), "runHours": float(run), "totalHours": float(allowance)})
        rows.append({"label": name, "amount": float(allowance), "rate": float(work.hourlyRate), "basis": "batch"})
    totals = price({"marginPercent": 0, "items": [{"quantity": inputs.quantity, "id": "route",
                    "costRows": [dict(row, id=str(i)) for i, row in enumerate(rows)]}]})
    return {"sheetCount": sheet_count, "piecesPerSheet": layout["pieces_per_sheet"],
            "yieldPercent": layout["yield_percent"], "rows": rows, "operationHours": hours,
            "materialCost": totals["items"][0]["rows"][0]["cost"], "total": totals["estimatedCost"]}


if __name__ == "__main__":
    try:
        request = Routing.model_validate_json(sys.stdin.buffer.read())
        print(json.dumps(estimate(request), allow_nan=False))
    except ValidationError as error:
        first = error.errors(include_input=False, include_url=False)[0]
        print("Check " + ".".join(map(str, first["loc"])) + ". " + first["msg"], file=sys.stderr)
        sys.exit(2)
    except (ValueError, DecimalException) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
