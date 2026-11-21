"""Extend provisional drawing takeoff measurements using the selected stock rate."""

from decimal import Decimal, ROUND_HALF_UP

from .engine import number


def quantities(rows, trim_percent):
    trim = 1 + number(trim_percent) / 100
    result = []
    for row in rows:
        a, b, c, d = [number(value or 0) for value in row["inputs"]]
        method = row["method"]
        density = number(row.get("density") or 0)
        if method == "product":
            amount = a * b
        elif method == "rate_allowance":
            amount = a * number(row["budgetAmount"])
        elif method == "plate_area":
            amount = a * 144 * b * density
        elif method == "angle":
            if not 0 < d < min(b, c):
                result.append(None)
                continue
            amount = a * 12 * (b * d + (c - d) * d) * density
        elif method == "rect_tube":
            if not 0 < 2 * d < min(b, c):
                result.append(None)
                continue
            amount = a * 12 * (b * c - (b - 2 * d) * (c - 2 * d)) * density
        elif method == "bar":
            amount = a * 12 * b * c * density
        elif method == "weight_per_foot":
            amount = a * b
        else:
            amount = a
        if row.get("trim"):
            amount *= trim
        result.append(float(amount.quantize(Decimal(".0001"), rounding=ROUND_HALF_UP))
                      if 0 < amount <= 1_000_000_000 else None)
    return result
