from packages.costing.engine import price


def test_batch_unit_cost_floor_and_additional_material_buffer():
    material = {
        "id": "steel",
        "amount": 1,
        "rate": 8,
        "basis": "per_unit",
        "material": True,
    }
    labor = {"id": "labor", "amount": 1.5, "rate": 60, "basis": "batch"}
    delivery = {"id": "delivery", "amount": 1, "rate": 30, "basis": "batch"}
    q = {
        "marginPercent": 25,
        "items": [
            {"id": "parts", "quantity": 10, "costRows": [material, labor]},
            {"id": "deliver", "quantity": 1, "costRows": [delivery]},
        ],
    }
    assert (price(q)["estimatedCost"], price(q)["sellingPrice"]) == (200, 266.67)
    q["scrapBufferPct"] = 10
    assert (price(q)["estimatedCost"], price(q)["sellingPrice"]) == (208, 277.33)
    material["unitCost"] = 9
    labor["unitCost"] = 100
    assert price(q)["estimatedCost"] == 229 and price(q)["items"][0]["scrapCost"] == 9
    material["minimumCost"] = 120
    assert price(q)["estimatedCost"] == 262
