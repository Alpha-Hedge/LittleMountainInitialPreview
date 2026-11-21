"""Extended row rounding, gross margin and largest-remainder line allocation."""
from decimal import Decimal, ROUND_HALF_UP, localcontext


CENT = Decimal(".01")
LIMIT = Decimal("1000000000000")


def number(value):
    amount = Decimal(str(value))
    if not amount.is_finite() or amount < 0:
        raise ValueError("Enter a finite, nonnegative amount.")
    return amount


def cents(value):
    amount = value.quantize(CENT, rounding=ROUND_HALF_UP)
    if amount > LIMIT:
        raise ValueError("The quote exceeds the supported dollar limit.")
    return amount


def allocate(total, costs):
    """Allocate the exact approved total using stable line order to break ties."""
    total_cents = int(cents(number(total)) * 100)
    weights = [int(cents(number(cost)) * 100) for cost in costs]
    weight = sum(weights)
    if not weight:
        if total_cents:
            raise ValueError("A positive selling price requires a cost basis.")
        return [0] * len(weights)
    splits = [divmod(total_cents * value, weight) for value in weights]
    result = [whole for whole, _ in splits]
    order = sorted(range(len(result)), key=lambda i: -splits[i][1])
    for index in order[:total_cents - sum(result)]:
        result[index] += 1
    return [value / 100 for value in result]


def price(draft):
    with localcontext() as ctx:
        ctx.prec = 48
        margin = number(draft["marginPercent"]) / 100
        scrap = number(draft.get("scrapBufferPct", 0)) / 100
        if scrap > 1:
            raise ValueError("The material scrap buffer must be between 0 and 100%.")
        if margin >= 1:
            raise ValueError("Gross margin must be below 100%.")
        total = Decimal(0)
        site_total = Decimal(0)
        contingency = number(draft.get("contingencyPercent", 0)) / 100
        if contingency > 1:
            raise ValueError("Budget contingency must be between 0 and 100%.")
        items = []
        for item in draft["items"]:
            quantity = item["quantity"]
            if type(quantity) is not int or quantity <= 0:
                raise ValueError("Enter a positive whole number of pieces.")
            subtotal = Decimal(0)
            material_cost = Decimal(0)
            rows = []
            for row in item["costRows"]:
                basis = row["basis"]
                if basis not in ("per_unit", "batch"):
                    raise ValueError("Choose per piece or per batch.")
                units = quantity if basis == "per_unit" else 1
                extended = number(row["amount"]) * number(row["rate"]) * units
                if row.get("unitCost") is not None:
                    extended = number(row["unitCost"]) * units
                minimum = number(row.get("minimumCost", 0))
                cost = cents(max(extended, minimum))
                if row.get("site"):
                    site_total += cost
                rows.append({"id": row["id"], "cost": float(cost)})
                subtotal += cost
                if row.get("material"):
                    material_cost += cost
            buffer = cents(material_cost * scrap)
            subtotal += buffer
            items.append({"id": item["id"], "cost": float(cents(subtotal)), "rows": rows,
                          **({"scrapCost":float(buffer)} if scrap else {})})
            total += subtotal
        shop_direct = total - site_total
        reserve = cents(total * contingency)
        if reserve:
            for item, share in zip(items, allocate(reserve, [item["cost"] for item in items])):
                item["contingencyCost"] = share
                item["cost"] = float(cents(number(item["cost"]) + number(share)))
            total += reserve
        selling = cents(total / (1 - margin))
        return {"estimatedCost": float(cents(total)), "sellingPrice": float(selling), "items": items,
                **({"contingencyCost": float(reserve)} if reserve else {}),
                **({"shopOnlySellingPrice": float(cents((shop_direct + cents(shop_direct * contingency)) / (1 - margin)))}
                   if draft.get("showShopOption") and site_total else {})}
