import unittest
from copy import deepcopy
from decimal import Decimal as D
from math import pi

from packages.cad.cost_engine import (
    CostInputError,
    CostSettings,
    calculate_cost,
    demo_settings,
    reprice_result,
)


def evidence(**values):
    return {
        "confidence": 1,
        "evidence": [
            {
                "source": "review",
                "excerpt": "Confirmed dimensioned test drawing.",
                "fields": list(values),
            }
        ],
        **values,
    }


def plate(part_id="A", qty=2):
    return {
        **evidence(
            part_id=part_id,
            description="Bracket",
            material_family="carbon steel",
            material_grade="A36",
            thickness_in=0.25,
            quantity=qty,
            dimension_basis="flat",
        ),
        "outline": evidence(
            kind="rectangle", width_in=5, height_in=5, corner_radius_in=0
        ),
    }


def ast(*parts):
    return {"source_units": "in", "drawing_revision": "A", "parts": list(parts)}


def rates():
    s = demo_settings().model_dump(mode="json")
    s["materials"][0].update(
        sheet_width_in="10", sheet_height_in="10", margin_in=0, spacing_in=0
    )
    s["cut"].update(kerf_in=0, speed_in_min=60, seconds_per_pierce=0)
    s["cut"]["center"].update(hourly_rate=60, setup_minutes=60)
    return s


def weld(**changes):
    return evidence(
        **{
            "process": "GMAW",
            "joint_type": "fillet",
            "size_in": 0.25,
            "length_in": 15,
            "position": "1F",
            "count": 1,
            "sides": 2,
            **changes,
        }
    )


def bend(**changes):
    return evidence(
        **{
            "angle_deg": 90,
            "inside_radius_in": 0.25,
            "length_in": 5,
            "count": 1,
            **changes,
        }
    )


class CostEngineTests(unittest.TestCase):
    def test_uncited_display_name_can_wait_but_quantity_cannot(self):
        p = plate()
        expected = calculate_cost(ast(p), rates())["estimated_cost_usd"]
        p["evidence"][0]["fields"].remove("description")
        self.assertEqual(calculate_cost(ast(p), rates())["estimated_cost_usd"], expected)
        p["evidence"][0]["fields"].remove("quantity")
        with self.assertRaisesRegex(CostInputError, "parts.0.quantity"):
            calculate_cost(ast(p), rates())

    def test_shared_plate_conservation_and_quantity(self):
        s = rates()
        result = calculate_cost(ast(plate("A", 1), plate("B", 1)), s)
        (group,) = result["stock_groups"]
        self.assertEqual(
            (group["sheet_count"], group["net_yield_pct"], group["scrap_pct"]),
            (1, "50", "50"),
        )
        self.assertEqual(group["stock_cost_usd"], "6.08")
        costs = [
            r["cost_usd"]
            for p in result["lines"]
            for r in p["rows"]
            if r["category"] == "material"
        ]
        self.assertEqual(costs, ["3.04", "3.04"])
        self.assertEqual(
            sum(r["stage"] == "setup" for p in result["lines"] for r in p["rows"]), 1
        )
        self.assertEqual(result["estimated_cost_usd"], "66.74")
        self.assertEqual(result["hours_by_work_center"][0]["setup_hours"], "1")
        self.assertAlmostEqual(
            float(result["hours_by_work_center"][0]["run_hours"]), 40 / 3600
        )
        self.assertEqual(result["selling_price_usd"], "88.99")
        self.assertEqual(
            sum(D(p["selling_price_usd"]) for p in result["lines"]), D("88.99")
        )
        s["cut"]["center"]["hourly_rate"] = 120
        self.assertEqual(result["settings"]["cut"]["center"]["hourly_rate"], "60")
        self.assertEqual(
            calculate_cost(ast(plate("A", 1), plate("B", 1)), s)["estimated_cost_usd"],
            "127.42",
        )

    def test_hole_kerf_compensation_and_batches(self):
        s = rates()
        s["cut"]["kerf_in"] = "0.1"
        p = plate(qty=3)
        p["holes"] = [
            evidence(
                shape="round",
                cutting_method="cut",
                center_x_in=2.5,
                center_y_in=2.5,
                diameter_in=1,
            )
        ]
        result = calculate_cost(ast(p), s)
        m = result["lines"][0]["metrics"]
        self.assertEqual(m["pierces"], 6)
        # The external quarter-arcs add one kerf circumference; the hole loses one.
        self.assertAlmostEqual(
            float(m["kerf_path_in"]), 3 * (20 + pi * 0.1 + pi * 0.9), places=8
        )
        self.assertAlmostEqual(float(m["net_area_in2_each"]), 25 - pi / 4, places=8)
        self.assertEqual(result["stock_groups"][0]["sheet_count"], 3)
        p["holes"][0]["diameter_in"] = 0.05
        with self.assertRaisesRegex(CostInputError, "Kerf"):
            calculate_cost(ast(p), s)

    def test_weld_weight_gas_deposition_and_bend_geometry(self):
        p = plate()
        p["bends"] = [bend()]
        p["welds"] = [weld(increment_in=3, pitch_in=12, position="3F")]
        s = rates()
        w = s["welds"][0]
        w.update(
            filler_density_lb_per_in3="0.3",
            deposit_lb_per_arc_hour=2,
            deposition_efficiency="0.8",
            arc_on_fraction="0.5",
            position_factors={"3F": "0.5"},
            gas_flow_scfh=30,
            gas_seconds_per_start=5,
        )
        line = calculate_cost(ast(p), s)["lines"][0]
        m = line["metrics"]
        (used,) = m["welds"]
        self.assertEqual((used["starts"], used["welded_length_in"]), (8, "24"))
        self.assertEqual(used["deposited_lb"], "0.225")
        self.assertEqual(used["filler_lb"], "0.28125")
        self.assertEqual(used["arc_hours"], "0.225")
        self.assertEqual(used["run_hours"], "0.45")
        self.assertAlmostEqual(float(used["gas_scf"]), 30 * (0.225 + 8 * 5 / 3600))
        self.assertAlmostEqual(
            float(m["bend_deduction_in_each"]), 1 - (0.25 + 0.42 * 0.25) * pi / 2
        )
        self.assertEqual(m["flat_width_in"], "5")
        self.assertEqual(line["processes"], ["CUT", "BEND", "GMAW"])

    def test_outside_legs_developed_once_and_tool_setup(self):
        p = plate()
        p["dimension_basis"] = "outside_flange_sum"
        p["development_axis"] = "width"
        p["evidence"][0]["fields"].append("development_axis")
        p["bends"] = [bend(tool_id="V-1"), bend(tool_id="V-1")]
        line = calculate_cost(ast(p), rates())["lines"][0]
        self.assertAlmostEqual(
            float(line["metrics"]["flat_width_in"]),
            5 - 2 * (1 - (0.25 + 0.42 * 0.25) * pi / 2),
        )
        setup = [
            r for r in line["rows"] if r["category"] == "bend" and r["stage"] == "setup"
        ]
        self.assertEqual(len(setup), 1)
        p["development_axis"] = None
        with self.assertRaises(CostInputError):
            calculate_cost(ast(p), rates())

    def test_uncertainty_and_unsupported_welds_block_total(self):
        p = plate()
        p["confidence"] = 0.4
        with self.assertRaisesRegex(CostInputError, "below 0.85"):
            calculate_cost(ast(p), rates())
        calculate_cost(ast(p), rates(), accepted_low_confidence=frozenset({"parts.0"}))
        p["material_grade"] = None
        with self.assertRaises(CostInputError):
            calculate_cost(
                ast(p), rates(), accepted_low_confidence=frozenset({"parts.0"})
            )
        p = plate()
        p["welds"] = [weld(increment_in=3, pitch_in=8)]
        with self.assertRaisesRegex(CostInputError, "stitch"):
            calculate_cost(ast(p), rates())
        p["welds"] = [weld(joint_type="groove", position="1G")]
        with self.assertRaisesRegex(CostInputError, "cross"):
            calculate_cost(ast(p), rates())
        p["welds"] = [
            weld(joint_type="groove", position="1G", cross_section_area_in2=0.1)
        ]
        calculate_cost(ast(p), rates())

    def test_scope_allowances_and_rule_reprice(self):
        p = plate()
        p["finish"] = "Powder coat"
        p["evidence"][0]["fields"].append("finish")
        with self.assertRaisesRegex(CostInputError, "Powder coat"):
            calculate_cost(ast(p), rates())
        s = rates()
        s["allowances"] = [
            {
                "part_id": "A",
                "requirement": "Powder coat",
                "description": "Vendor coating",
                "amount": "1.25",
                "rate": "16",
                "basis": "per_unit",
                "source": "Vendor offer A",
            }
        ]
        result = calculate_cost(ast(p), s)
        changed = deepcopy(result)
        allowance = next(
            r for r in changed["lines"][0]["rows"] if r["category"] == "allowance"
        )
        self.assertEqual(allowance["cost_usd"], "40.00")
        allowance["amount"] = "1.5"
        changed["gross_margin_pct"] = "50"
        repriced = reprice_result(changed)
        self.assertEqual(
            D(repriced["estimated_cost_usd"]) - D(result["estimated_cost_usd"]), D(8)
        )
        self.assertEqual(
            D(repriced["selling_price_usd"]), D(repriced["estimated_cost_usd"]) * 2
        )
        self.assertEqual(result["gross_margin_pct"], "25")

    def test_large_batch_and_invalid_stock(self):
        result = calculate_cost(ast(plate(qty=1001)), rates())
        self.assertEqual(result["stock_groups"][0]["sheet_count"], 251)
        p = plate()
        p["outline"]["height_in"] = 30
        with self.assertRaisesRegex(CostInputError, "fit"):
            calculate_cost(ast(p), rates())
        s = rates()
        s["welds"][0]["process"] = "SMAW"
        with self.assertRaisesRegex(ValueError, "SMAW"):
            CostSettings.model_validate(s)
