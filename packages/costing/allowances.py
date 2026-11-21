"""Convert confirmed drawing callouts into explicit template drivers."""
import re
from decimal import Decimal, ROUND_HALF_UP

UNITS = {u: Decimal(v) for u, v in (
    ("mm", ".001"), ("cm", ".01"), ("m", "1"), ("in", ".0254"),
    ("inch", ".0254"), ("inches", ".0254"), ('"', ".0254"))}
AXIS = r'(\d+(?:\.\d+)?)\s*(mm|cm|m|inches|inch|in|")?'
COUNT = re.compile(r"\b(\d+)\s*(?:[x×]\s*(?:dia\b|[ø⌀])|\s+(?:(?:through|thru|blind|mounting|clearance|tapped)[- ])*holes?\b)", re.I)
AMBIGUOUS = re.compile(r"(?:\d\s*(?:to|or|and|[,.\/×x–—-])|at least|up to|about|approximately|[≈~−-])\s*$", re.I)


def measure(driver, fields):
    if driver == "fixed":
        return Decimal(1), "Fixed template allowance"
    if driver == "holes":
        source = fields.get("requirements", "")
        hits = list(COUNT.finditer(source))
        if len(hits) == 1 and not AMBIGUOUS.search(source[:hits[0].start()]):
            count = int(hits[0][1])
            if count:
                return Decimal(count), f"Reviewed hole count {count} ({source})"
        return None, "Confirm the hole count and enter the operation amount"
    if driver not in ("length_m", "area_m2"):
        raise ValueError("Unknown operation measurement.")
    raw = fields.get("dimensions", "")
    dimensions = raw.lower().strip()
    units = fields.get("units", "").lower().strip()
    pair = re.fullmatch(AXIS + r"\s*[x×]\s*" + AXIS, dimensions)
    length = re.search(r"\blength\s*[:=]?\s*" + AXIS + r"(?=\s|,|$)", dimensions)
    width = re.search(r"\bwidth\s*[:=]?\s*" + AXIS + r"(?=\s|,|$)", dimensions)
    if pair:
        x, ux, y, uy = pair.groups()
        x = Decimal(x) * UNITS.get(ux or uy or units, 0)
        y = Decimal(y) * UNITS.get(uy or ux or units, 0)
    else:
        x = Decimal(length[1]) * UNITS.get(length[2] or units, 0) if length else 0
        y = Decimal(width[1]) * UNITS.get(width[2] or units, 0) if width else 0
    area = driver == "area_m2"
    value = x * y if area else x
    if value:
        return value, f"Reviewed {'rectangular blank' if area else 'length'} {raw} ({value.normalize():f} {'m²' if area else 'm'})"
    return None, "Enter the amount after confirming the " + ("rectangular blank dimensions" if area else "length") + " and units"


def coefficient(amount, factor, divisor=1):
    result = Decimal(str(amount)) * Decimal(str(factor)) / Decimal(str(divisor))
    return float(result.quantize(Decimal(".0001"), rounding=ROUND_HALF_UP))


def build_allowances(operations, fields):
    rows = []
    for op in operations:
        factor, basis = measure(op["driver"], fields)
        rows.append({"factor": float(factor) if factor is not None else None, "basis": basis,
                     "amount": coefficient(op["amount"], factor or 0)})
    return rows
