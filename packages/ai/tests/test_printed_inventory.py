from copy import deepcopy

from packages.ai.blueprint_extractor import CoverageComponent, _decode
from packages.ai.printed_inventory import reconcile_inventory
from packages.ai.schemas import EngineeringAST, EngineeringPart
from packages.ai.tests.test_blueprint import output


def test_reconciles_repeated_and_omitted_printed_components():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.section_designation = "C3x6"
    pages = {1: 'C3X6 CHANNEL\n8" COPPER\nHALF ROUND GUTTER\n6" COPPER DOWNSOUT', 2: '8" copper half-round gutter'}
    rows = reconcile_inventory(ast, pages)
    assert [(item["status"], item["page"]) for item in rows] == [("captured", 1), ("recovered", 1), ("recovered", 1)]
    assert ast.parts[1].material_family == "copper"
    assert ast.parts[2].quantity is None and ast.parts[2].outline.kind == "unknown"
    assert ast.parts[2].evidence[0].excerpt == '6" COPPER DOWNSOUT'
    assert len(reconcile_inventory(ast, pages)) == 3 and len(ast.parts) == 3
    assert [item["part_id"] for item in reconcile_inventory(ast, pages)] == [item["part_id"] for item in rows]


def test_second_pass_only_adds_candidates_with_literal_page_evidence():
    ast = EngineeringAST.model_validate(_decode(output()))
    candidates = [
        CoverageComponent(page=1, label="STAINLESS WALL SUPPORT", stock_form="other",
                          evidence="STAINLESS WALL SUPPORT BY OTHERS"),
        CoverageComponent(page=2, label="MOUNTING CLIP", stock_form="other", evidence="MOUNTING CLIP FOR WALL"),
        CoverageComponent(page=2, label="PLASMA RAIL", stock_form="other", evidence="PLASMA RAIL FOR CUTTING"),
    ]
    rows = reconcile_inventory(ast, {1: "STAINLESS WALL SUPPORT BY OTHERS", 2: "MOUNTING CLIP FOR WALL"}, candidates)
    assert len(rows) == 1 and rows[0]["label"] == "MOUNTING CLIP"
    assert ast.parts[-1].quantity is None


def test_callout_at_part_limit_remains_visible_for_review():
    ast = EngineeringAST.model_validate(_decode(output()))
    original = ast.parts[0].model_dump()
    for index in range(49):
        ast.parts.append(EngineeringPart.model_validate({**deepcopy(original), "part_id": f"other-{index}"}))
    rows = reconcile_inventory(ast, {3:'6" COPPER DOWNSOUT'})
    assert rows[0]["status"] == "review" and rows[0]["part_id"] is None


def test_added_hardware_and_finish_callouts_preserve_saved_exclusions():
    ast = EngineeringAST.model_validate(_decode(output()))
    pages = {3: 'MAINE DECK BRACKET ATTACHED TO FLAT ROOF FRAMING\n'
                'METAL FURRING STRIPS\n6" COPPER DOWNSOUT\nEXISTING WALL BRACKET',
             4: 'LIGHTING FIXTURE\nCOPPER DRIP AND EPDM EXTENSION\nMOUNTING CLIP BY OTHERS'}
    original = reconcile_inventory(ast, {3: '6" COPPER DOWNSOUT'})
    ast.parts.pop()
    rows = reconcile_inventory(ast, pages, prior_callouts=original)
    assert rows[:1] == original
    assert {row["label"] for row in rows[1:]} == {
        "MAINE DECK BRACKET", "METAL FURRING STRIPS", "LIGHTING FIXTURE",
        "COPPER DRIP", "EPDM EXTENSION",
    }
    assert all(part.quantity is None for part in ast.parts[1:])
    assert not any(part.part_id == original[0]["part_id"] for part in ast.parts)
    assert reconcile_inventory(ast, pages, prior_callouts=rows) == rows
