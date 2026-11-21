from decimal import Decimal

import pytest

from packages.costing.bridge import evaluate
from packages.costing.engine import allocate, price


def test_extended_rounding_and_minimum_after_quantity():
    rows = [
        {"id": "a", "basis": "per_unit", "rate": 0.005, "amount": 1},
        {"id": "b", "basis": "per_unit", "rate": 0.001, "amount": 1, "minimumCost": 10},
        {"id": "c", "basis": "batch", "rate": 2, "amount": 30},
    ]
    totals = price({"items": [{"id": "plate", "quantity": 3, "costRows": rows}], "marginPercent": 25})
    assert [r["cost"] for r in totals["items"][0]["rows"]] == [0.02, 10, 60]
    assert totals["estimatedCost"] == 70.02 and totals["sellingPrice"] == 93.36
    assert allocate(1, [2, 2, 2]) == [0.34, 0.33, 0.33]
    assert allocate(0, [0, 0]) == [0, 0]


def test_operational_limits_and_actuals():
    with pytest.raises(ValueError, match="margin"):
        price({"items": [], "marginPercent": 100})
    with pytest.raises(ValueError, match="limit"):
        price({"items": [{"id": "a", "quantity": 100000, "costRows": [
            {"id": "r", "basis": "per_unit", "rate": 1000000, "amount": 100000}]}], "marginPercent": 0})
    assert evaluate({"operation": "actuals", "rows": [[1, Decimal(".005")], [8, None]]}) == {"rows":[0.01,None],"total":0.01}


def test_sheet_price_uses_physical_units_and_confirmed_rates():
    sheet = evaluate({"operation":"sheet", "width":25.4, "height":25.4, "thickness":25.4,
                      "density":0.25, "price":8})
    assert sheet == {"weightLb":0.25, "cost":2.0}


def test_drawing_takeoff_stock_trim_and_contingency_are_applied_once():
    weights = evaluate({"operation":"takeoff","trimPercent":12,"rows":[
        {"method":"plate_area","inputs":[170,.125,None,None],"density":.283,"trim":True},
        {"method":"rect_tube","inputs":[125,1.5,1.5,.25],"density":.283,"trim":True},
        {"method":"rect_tube","inputs":[125,1.5,1.5,1],"density":.283,"trim":True},
        {"method":"direct","inputs":[10,None,None,None],"trim":False},
    ]})
    assert weights == [969.8976,594.3,None,10]
    result = price({"marginPercent":25,"contingencyPercent":15,"items":[
        {"id":"stock","quantity":12,"costRows":[{"id":"sh","basis":"batch","amount":100,"rate":2}]},
        {"id":"shop","quantity":1,"costRows":[{"id":"lab","basis":"batch","amount":2,"rate":75}]},
    ]})
    assert result["contingencyCost"] == 52.5
    assert [item["contingencyCost"] for item in result["items"]] == [30,22.5]
    assert result["estimatedCost"] == 402.5 and result["sellingPrice"] == 536.67


def test_installed_budget_and_shop_option_share_one_takeoff():
    rows = [
        {"id":"material","basis":"batch","amount":10,"rate":25},
        {"id":"shop","basis":"batch","amount":3,"rate":75},
        {"id":"installation","basis":"batch","amount":4,"rate":125,"site":True},
    ]
    draft = {"marginPercent":25,"contingencyPercent":15,"showShopOption":True,
             "items":[{"id":"assembly","quantity":1,"costRows":rows}]}
    installed = price(draft)
    shop = price({**draft,"items":[{"id":"assembly","quantity":1,"costRows":rows[:-1]}]})
    assert installed["shopOnlySellingPrice"] == shop["sellingPrice"] == 728.33
    assert installed["sellingPrice"] == 1495.0
