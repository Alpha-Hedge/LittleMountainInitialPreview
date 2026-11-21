"""Versioned budget allowances for a U.S. small fabrication shop demo."""
from decimal import Decimal, ROUND_HALF_UP
import re
from collections import defaultdict


def grade_key(value):
    return re.sub(r"[^a-z0-9]", "", re.sub(r"^\s*(?:ASTM|AISI|SAE|Type)\s*", "", value or "", flags=re.I).lower())


def stock_price(part, rates, demo):
    grade = grade_key(part.get("material_grade"))
    family = str(part.get("material_family") or "").strip().lower()
    fallback = demo and not grade and family in ("", "steel", "mild steel", "carbon steel") and not re.search(
        r"\b(?:stainless|alumin(?:um|ium)|copper|brass|bronze|titanium|316L?|5052|galv\w*)\b",
        str(part.get("section_designation") or "") + " " + str(part.get("description") or ""), re.I,
    )
    grade = "a36" if fallback else grade
    if not grade:
        return None, False
    thickness = positive(part.get("thickness_in"))
    family = family.replace("mild steel","carbon steel").replace("aluminium","aluminum")
    candidates = [rate for rate in rates if rate.get("category") == "material" and rate.get("form") == "sheet / plate"
                  and rate["unit"].lower() == "lb" and positive(rate.get("density")) and grade_key(rate.get("grade")) == grade
                  and (not rate.get("family") or family in ("", "steel", rate["family"].lower()))
                  and (rate.get("thicknessIn") is None or positive(rate["thicknessIn"]) == thickness)]
    exact = [rate for rate in candidates if rate.get("thicknessIn") is not None]
    if exact:
        candidates = exact
    # If two independent supplier entries exist, the estimator needs a selection.
    return (candidates[0], fallback) if len(candidates) == 1 else (None, False)


def positive(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    value = Decimal(str(value))
    return value if value.is_finite() and 0 < value <= 100_000 else None


def row(key, label, amount, rate, basis, rationale):
    rounded = Decimal(amount).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    return {"key": key, "label": label, "amount": float(rounded), "rate": float(rate["value"]),
            "unit": rate["unit"], "category": rate["category"], "basis": basis, "rationale": rationale,
            "includes": rate["includes"], "source": rate["source"], "effectiveOn": rate["effectiveOn"],
            "rateRevision": rate["version"], "rateId": rate["id"], "minimumCost":float(rate["minimumCost"])}


def estimate_line(part, blocked, rates, roles, trim_percent, demo):
    rows, checks = [], []
    shape = part.get("stock_form")
    outline = part.get("outline") or {}
    plate = shape in ("plate", "sheet") or (not shape and outline.get("kind") in ("rectangle", "polygon"))
    bent = bool(part.get("bends"))
    thickness = positive(part.get("thickness_in"))
    width, height = (positive(outline.get(key)) for key in ("width_in", "height_in"))
    dimensional_blocks = ("outline", "outline.width_in", "outline.height_in", "thickness_in")
    def operation(key, label, count, rationale):
        rate = roles.get(key)
        if rate is None:
            checks.append(f"Add a current shop rate for {label.lower()}.")
            return
        allowance = Decimal(str(rate["budgetAmount"]))
        rows.append(row(key, label, allowance * count, rate, "per_unit",
                        f"{count} × {allowance} {rate['unit']} per piece. {rationale}"))

    if plate:
        stock, assumed_steel = stock_price(part, rates, demo)
        if stock is None:
            checks.append("Confirm the material grade and matching supplier price.")
        unclear_development = bent and (part.get("dimension_basis") != "flat" or "dimension_basis" in blocked)
        if not all((thickness, width, height)) or unclear_development or any(key in blocked for key in dimensional_blocks):
            checks.append("Confirm the flat blank size and thickness for material pricing.")
        elif stock is not None and not blocked.intersection({"material_family", "material_grade"}):
            density = Decimal(str(stock["density"]))
            pounds = width * height * thickness * density * (1 + trim_percent / 100)
            if Decimal("0.0001") <= pounds <= 1_000_000_000:
                label = "Mild steel stock allowance" if assumed_steel else stock["name"] + " stock"
                rows.append(row("stock", label, pounds, stock, "per_unit",
                                f"{width} × {height} × {thickness} in blank at {density} lb/in³ with {trim_percent}% for trim and scrap."))
                if assumed_steel:
                    checks.append("Verify the assumed mild steel grade and supplier price.")
        elif stock is not None:
            checks.append("Verify the material reading before pricing stock.")
        if "stock_form" not in blocked:
            operation("blank", "Cut and deburr blank", 1,
                      "Load, cut and deburr. Review cut length and complexity.")
    elif shape in ("tube", "angle", "channel", "beam", "bar", "pipe") and "stock_form" not in blocked:
        operation("saw", "Cut structural stock", 1,
                  "Simple cut to length. Confirm cut count, miters and handling.")
        checks.append("Confirm cut lengths, stock quantity and supplier cost.")
    else:
        checks.append("Confirm the work scope and separately price this assembly or purchased item.")

    holes = sum(int(positive(hole.get("count")) or 1) for hole in (part.get("holes") or []) if hole.get("cutting_method") == "drill")
    if holes:
        operation("drill", "Drill openings", holes,
                  "Confirm hole sizes and drilling method.")
    bends = sum(int(positive(bend.get("count")) or 1) for bend in (part.get("bends") or []))
    if bends and plate:
        operation("form", "Form bends", bends,
                  "Confirm tooling, handling and developed size.")
    welds = part.get("welds") or []
    shop = sum(int(positive(weld.get("count")) or 1) for weld in welds if weld.get("field_weld") is False)
    if shop:
        operation("weld", "Shop fit-up and welding", shop,
                  "Verify joint length, process and fit-up.")
        operation("consumables", "Weld wire and gas allowance", shop, "Allowance per routine shop joint. Check process and quantities.")
    if any(weld.get("field_weld") is not False for weld in welds):
        checks.append("Confirm where welding happens and price any site work separately.")
    if part.get("finish"):
        checks.append("Price the specified finish and any outside processing.")
    return rows, checks


def benchmark(parts, existing_setup, rates, trim_percent, demo):
    trim_percent = Decimal(str(trim_percent))
    candidates = defaultdict(list)
    for rate in rates:
        if rate.get("budgetRole"):
            candidates[rate["budgetRole"]].append(rate)
    roles = {key: rows[0] for key, rows in candidates.items() if len(rows) == 1}
    lines = []
    for entry in parts:
        rows, checks = estimate_line(entry["part"], set(entry["blocked"]), rates, roles, trim_percent, demo)
        if rows and not existing_setup:
            if "setup" in roles:
                rows.insert(0, row("setup", "Batch layout and setup", Decimal(str(roles["setup"]["budgetAmount"])), roles["setup"], "batch",
                                   "Saved job layout and initial setup allowance, charged once for the batch."))
            else:
                checks.append("Add the shared batch setup cost.")
            existing_setup = True
        lines.append({"id": entry["id"], "rows": rows, "checks": checks})
    return {"lines": lines}
