from copy import deepcopy
from itertools import combinations

import pytest
from shapely.geometry import box

from packages.cad.nesting import plan_rectangular_batch, plan_stock


def plate(pid, w, h, qty, material="A36", thickness=2):
    return {
        "part_id": pid,
        "name": pid,
        "quantity": qty,
        "material": material,
        "thickness": thickness,
        "outline": {"kind": "rectangle", "width": w, "height": h, "corner_radius": 0},
    }


def request(parts, rotate=True):
    return {
        "drawing": {"title": "Test", "revision": "A", "units": "mm", "parts": parts},
        "stock": [
            {
                "material": "A36",
                "thickness": 2,
                "width": 100,
                "height": 60,
                "spacing": 2,
                "margin": 2,
                "allow_rotate": rotate,
            }
        ],
    }


def verify_positions(nest, ordered, kerf=0):
    count = {}
    for sheet in nest.sheets:
        stock = sheet.stock
        m = stock.margin + kerf
        usable = box(m, m, stock.width - m, stock.height - m)
        shapes = []
        for placement in sheet.placements:
            count[placement.part_id] = count.get(placement.part_id, 0) + 1
            x, y = placement.x, placement.y
            geom = box(x, y, x + placement.width, y + placement.height)
            assert usable.covers(geom)
            shapes.append(geom)
        for a, b in combinations(shapes, 2):
            assert a.intersection(b).area == 0
            assert a.distance(b) + 1e-8 >= stock.spacing + 2 * kerf
    assert count == ordered


def test_mixed_batch_material_segregation_kerf_and_yield():
    data = request(
        [plate("L", 60, 20, 7), plate("S", 15, 24, 4), plate("T", 62, 23, 3, "304SS", 3)]
    )
    data["drawing"]["kerf_width"] = 1.2
    data["stock"].append({**data["stock"][0], "material": "304SS", "thickness": 3})
    result = plan_stock(data)
    assert result == plan_stock(deepcopy(data))
    verify_positions(result, {"L": 7, "S": 4, "T": 3}, kerf=1.2)
    for sheet in result.sheets:
        assert all(
            (p.part_id == "T") == (sheet.stock.material == "304SS") for p in sheet.placements
        )
    area = 7 * 60 * 20 + 4 * 15 * 24 + 3 * 62 * 23
    assert result.net_yield_percent == pytest.approx(100 * area / (6000 * result.sheet_count))
    assert result.unused_blank_area == result.sheet_count * 6000 - area


@pytest.mark.parametrize(
    "w,h,rotate", [(57, 25, True), (23, 45, True), (43, 19, False), (0.01, 0.012, True)]
)
def test_identical_batch_prices_the_layout_it_draws(w, h, rotate):
    data = request([plate("P", w, h, 80)], rotate)
    actual = plan_stock(data)
    expected = plan_rectangular_batch(100, 60, w, h, 2, 2, rotate, 80)
    assert expected["sheet_count"] == actual.sheet_count
    verify_positions(actual, {"P": 80})
    assert expected["yield_percent"] == pytest.approx(actual.blank_yield_percent)


def test_rotation_unavailable_stock_and_run_limits():
    data = request([plate("P", 55, 90, 1)], False)
    with pytest.raises(ValueError, match="will not fit"):
        plan_stock(data)
    data["stock"][0]["allow_rotate"] = True
    assert plan_stock(data).sheets[0].placements[0].rotated
    data["drawing"]["parts"][0]["quantity"] = 1001
    with pytest.raises(ValueError, match="1,000"):
        plan_stock(data)
    data["drawing"]["parts"][0].update(quantity=1, material="6061")
    with pytest.raises(ValueError, match="Choose stock"):
        plan_stock(data)
    batch = plan_rectangular_batch(48, 96, 12, 12, 0, 0, False, 1_000_000_000)
    assert batch["sheet_count"] == 31_250_000 and batch["pieces_per_sheet"] == 32


@pytest.mark.parametrize("invalid", ["1e1000000", "1e-1000000", "nan", "steel", 0, True])
def test_batch_model_rejects_out_of_range_dimensions(invalid):
    with pytest.raises(ValueError):
        plan_rectangular_batch(48, 96, invalid, 12, 0, 0, True, 5)


def test_nesting_rejects_kerf_that_would_erase_opening():
    part = plate("A", 10, 10, 2)
    part["holes"] = [{"shape": "round", "center": {"x": 5, "y": 5}, "diameter": 1}]
    data = request([part])
    data["drawing"]["kerf_width"] = 1
    with pytest.raises(ValueError, match="closes a round hole"):
        plan_stock(data)
