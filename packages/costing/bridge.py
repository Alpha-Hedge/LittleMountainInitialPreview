"""JSON stdin/stdout interface for the local desk. Amounts use decimal arithmetic."""
import json
import sys
from decimal import Decimal, DecimalException

from .engine import allocate, cents, number, price
from .allowances import build_allowances, coefficient
from .benchmark import benchmark
from .takeoff import quantities


def evaluate(request):
    operation = request["operation"]
    if operation == "price":
        return price(request["draft"])
    if operation == "benchmark":
        return benchmark(request["parts"], request.get("existingSetup", False), request["rates"], request["trimPercent"], request["demo"])
    if operation == "takeoff":
        return quantities(request["rows"], request["trimPercent"])
    if operation == "allocate":
        return allocate(request["total"], request["costs"])
    if operation == "actuals":
        costs = [None if rate is None or amount is None else cents(number(amount) * number(rate))
                 for amount, rate in request["rows"]]
        return {"rows": [float(cost) if cost is not None else None for cost in costs],
                "total": float(cents(sum(x for x in costs if x is not None)))}
    if operation == "allowances":
        return build_allowances(request["operations"], request["fields"])
    if operation == "coefficient":
        return coefficient(request["amount"], request["factor"], request.get("divisor", 1))
    if operation == "sheet":
        # 25.4 mm per inch is exact. The nesting estimate buys full sheets.
        dims = [number(request[key]) for key in ("width", "height", "thickness")]
        density, rate = number(request["density"]), number(request["price"])
        if not all(0 < d <= 1_000_000 for d in dims) or density <= 0:
            raise ValueError("Enter positive sheet dimensions, thickness and density.")
        pounds = dims[0] * dims[1] * dims[2] * density / Decimal("25.4")**3
        return {"weightLb": float(pounds), "cost": float(cents(pounds * rate))}
    raise ValueError("Unknown pricing operation.")


if __name__ == "__main__":
    try:
        print(json.dumps(evaluate(json.load(sys.stdin, parse_float=Decimal)), allow_nan=False))
    except (ValueError, KeyError, TypeError, DecimalException) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
