import hashlib
import json

import pytest
from pydantic import ValidationError

from packages.ai.blueprint_extractor import (
    BlueprintError,
    CoverageField,
    Document,
    _decode,
    _parse_primary,
    _read_dxf,
    _wire_schema,
    _written_measures,
    extract_blueprint,
    recover_order_quantities,
    recover_printed_fields,
)
from packages.ai.examples.blueprint_demo import make_drawing, make_metric_dxf
from packages.ai.schemas import BendSpec, EngineeringAST, Evidence, HoleSpec, WeldCallout


def citation(keys):
    return {
        "source": "pdf",
        "page": 1,
        "handle": None,
        "excerpt": "Units: inches",
        "fields": keys,
    }


def literal(val, unit="in"):
    return {"value": val, "unit": unit}


def output(confidence=0.85):
    outline = {
        "kind": "rectangle",
        "width_in": literal(6),
        "height_in": literal(4),
        "corner_radius_in": literal(0),
    }
    outline["evidence"] = [citation(list(outline))]
    outline.update(confidence=confidence, issues=[], vertices=[])
    p = {
        "quantity": 4,
        "material_family": "carbon steel",
        "material_grade": "A36",
        "description": "Fixture plate",
        "dimension_basis": "flat",
        "thickness_in": literal(0.25),
    }
    p.update(
        evidence=[citation(list(p))],
        confidence=0.85,
        outline=outline,
        part_id="FP-101",
        issues=[],
        holes=[],
        bends=[],
        welds=[],
        development_axis=None,
        finish=None,
        requirements=[],
    )
    p["evidence"][0]["excerpt"] = "Material: carbon steel, grade A36"
    return {"drawing_revision": "A", "source_units": "in", "parts": [p], "issues": []}


class FixtureReader:
    name = "test"
    model = "synthetic"

    def __init__(self, response):
        self.response = response
        self.messages = []

    def complete(self, messages, schema):
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == set(schema["properties"])
        self.messages = messages
        return json.dumps(self.response)


def test_multipart_pdf_images_raw_provenance_and_threshold():
    data = make_drawing()
    provider = FixtureReader(output())
    res = extract_blueprint(data, "plate.pdf", provider=provider)
    assert res.flags == [] and res.sha256 == hashlib.sha256(data).hexdigest()
    assert (
        res.ast.parts[0].thickness_in == 0.25
        and json.loads(res.raw_response) == provider.response
    )
    assert (
        len([p for p in provider.messages[1]["content"] if p["type"] == "image_url"])
        == 2
    )
    provider.response = output(0.849)
    flags = extract_blueprint(data, "plate.pdf", provider=provider).flags
    assert [(f.kind, f.path) for f in flags] == [("low_confidence", "parts.0.outline")]


def test_section_gauge_and_weld_qualifiers_stay_in_review():
    response = output()
    first = response["parts"][0]
    first.update(stock_form="tube", section_designation="HSS 2x2x1/4")
    first["evidence"].append(citation(["stock_form", "section_designation"]))
    from copy import deepcopy

    second, third, fourth = (deepcopy(first) for _ in range(3))
    second.update(part_id="BEAM", stock_form="beam", section_designation="W8x18")
    for part, label in ((third, "14ga"), (fourth, "11ga")):
        part.update(part_id=label, stock_form="sheet", section_designation=None,
                    gauge_designation=label, thickness_in=None)
        part["evidence"].append(citation(["gauge_designation"]))
    weld = dict(process=None, joint_type="fillet", joint_configuration=None, cross_section_area_in2=None,
                stitches_per_side=None, size_in=literal(.0625), length_in=None,
                increment_in=literal(1), pitch_in=literal(3), position=None,
                count=1, sides=1, all_around=True, field_weld=True, confidence=.7, issues=[])
    weld["evidence"] = [citation([*weld.keys()])]
    fourth["welds"] = [weld]
    response["parts"] += [second, third, fourth]
    res = extract_blueprint(make_drawing(), "parts.pdf", provider=FixtureReader(response))
    assert [p.section_designation for p in res.ast.parts[:2]] == ["HSS 2x2x1/4", "W8x18"]
    assert [p.gauge_designation for p in res.ast.parts[2:]] == ["14ga", "11ga"]
    assert res.ast.parts[3].welds[0].size_in == 1 / 16
    flags = {(f.path, f.kind) for f in res.flags}
    assert {("parts.0.stock_form", "unsupported"), ("parts.1.stock_form", "unsupported"),
            ("parts.3.thickness_in", "missing"), ("parts.3.welds.0", "low_confidence"),
            ("parts.3.welds.0.field_weld", "unsupported"), ("parts.3.welds.0.length_in", "missing")} <= flags


def test_source_stamp_is_recorded_without_a_review_gate():
    from io import BytesIO
    from reportlab.pdfgen.canvas import Canvas

    data = BytesIO()
    sheet = Canvas(data, pagesize=(2592, 1728))
    sheet.drawString(40, 700, "NOT FOR CONSTRUCTION")
    sheet.save()
    provider = FixtureReader(output())
    result = extract_blueprint(data.getvalue(), "review.pdf", provider=provider)
    assert result.ast.source_release_hold.startswith("Page 1")
    assert not any(flag.path == "source_release_hold" for flag in result.flags)
    assert sum(block["type"] == "image_url" for block in provider.messages[1]["content"]) == 5


def test_second_pass_recovers_only_part_bound_literal_values():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.material_grade = None
    part.thickness_in = None
    doc = Document("pdf", page_text={2: "FP-101 MATERIAL GRADE A36\nFP-101 THICKNESS 1/4\"\nFP-101 FINISH PAINT OR GALVANIZE"})
    rows = [
        CoverageField(page=2, part_id="FP-101", field="material_grade", value="A36", evidence="FP-101 MATERIAL GRADE A36"),
        CoverageField(page=2, part_id="FP-101", field="thickness_in", value='1/4"', evidence='FP-101 THICKNESS 1/4"'),
        CoverageField(page=2, part_id="FP-101", field="finish", value="PAINT", evidence="FP-101 FINISH PAINT OR GALVANIZE"),
        CoverageField(page=2, part_id="FP-101", field="section_designation", value="HSS 2x2", evidence="FP-101 HSS 2x2"),
    ]
    recovered = recover_printed_fields(ast, doc, rows)
    assert {item["field"] for item in recovered} == {"material_grade", "thickness_in"}
    assert part.material_grade == "A36" and part.thickness_in == 0.25 and part.finish is None
    assert part.evidence[-1].page == 2


def test_explicit_order_quantity_recovery_and_conflict():
    ast = EngineeringAST.model_validate(_decode(output()))
    ast.parts[0].quantity = None
    assert not recover_order_quantities(ast, '3 × 11 plate; 4x holes')
    assert recover_order_quantities(ast, "FP-101 Qty: 12 pieces")[0]["value"] == 12
    assert ast.parts[0].evidence[-1].source == "notes"
    assert not recover_order_quantities(ast, "Order quantity: 15")
    assert ast.parts[0].quantity is None and any("quantity conflicts" in issue for issue in ast.parts[0].issues)


def test_named_tube_and_customer_order_fill_only_supported_pricing_inputs():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.description = "Upper rails"
    part.stock_form = "tube"
    part.quantity = part.material_family = part.material_grade = part.thickness_in = part.section_designation = None
    part.finish = None
    note = 'FP-101: 2-1/2" x 1-1/2" x 3/16" STEEL TUBES welded to plates'
    recovered = recover_printed_fields(ast, Document("pdf", page_text={2: note}), [])
    assert {"thickness_in", "section_designation", "material_family"} <= {r["field"] for r in recovered}
    assert part.thickness_in == 0.1875 and part.material_family == "steel"
    assert part.quantity is None and part.finish is None and part.material_grade is None
    assert not recover_order_quantities(ast, "Upper rails qty 6 per assembly; 4X bolts")
    assert recover_order_quantities(ast, "Please quote 8 upper rails.")[0]["value"] == 8
    part.quantity = None
    part.thickness_in = None
    other = part.model_copy(deep=True, update={"part_id":"FP-102"})
    ast.parts.append(other)
    assert not recover_order_quantities(ast, "Please quote 8 upper rails.")
    assert not recover_printed_fields(ast, Document("pdf", page_text={2:'FP-101: connect to 2" x 2" x 1/4" steel tube'}), [])
    assert part.thickness_in is None


def test_second_read_fills_known_fields_and_partial_operations_instead_of_only_flagging():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.quantity = None
    part.outline.width_in = None
    part.material_grade = None
    part.holes = []
    part.bends = []
    part.welds = []
    pages = {2: '\n'.join([
        "UNITS: INCHES", "FP-101 ORDER QUANTITY: 6 PIECES", 'FP-101 WIDTH: 3-3/8"',
        "FP-101 MATERIAL GRADE A36", "FP-101 4X Ø0.50 THRU", "FP-101 BENT ON TOP AND BOTTOM",
        'FP-101 1/4" FILLET WELD', "FP-101 FINISH POWDER COAT OR GALVANIZE",
    ])}
    doc = Document("pdf", page_text=pages)
    recovered = recover_printed_fields(ast, doc, [])
    assert part.quantity == 6 and part.outline.width_in == 3.375 and part.material_grade == "A36"
    assert part.finish is None
    hole, = part.holes
    assert (hole.count, hole.diameter_in, hole.center_x_in, hole.center_y_in) == (4, .5, None, None)
    assert hole.evidence[-1].excerpt == "UNITS: INCHES"
    assert len(part.bends) == 2 and all(bend.angle_deg is None for bend in part.bends)
    weld, = part.welds
    assert weld.joint_type == "fillet" and weld.size_in == .25 and weld.length_in is None
    assert "holes.0.diameter_in" in {item["field"] for item in recovered}
    assert all(item["page"] == 2 for item in recovered)
    assert EngineeringAST.model_validate(ast.model_dump()).review_flags()
    assert not recover_printed_fields(ast, doc, [])


def test_second_read_protects_manual_blanks_and_rejects_conflicting_or_unbound_values():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.quantity = None
    part.material_grade = None
    part.material_family = None
    part.stock_form = "plate"
    part.finish = None
    part.outline.width_in = None
    part.evidence.append(Evidence(source="review", excerpt="Finish remains open pending supplier response.", fields=["finish"]))
    doc = Document("pdf", page_text={1: '\n'.join([
        "FP-101 ORDER QUANTITY: 6 PIECES", "FP-101 ORDER QUANTITY: 7 PIECES", "FP-101-A MATERIAL GRADE A572",
        'FP-101 1/8" PLATE WELDED TO STEEL TUBES', "FP-101 FINISH PAINT", "FP-101 4X Ø0.50 THRU",
        'FP-101 SLOT WIDTH: 1/2"', "FP-101 MAKE 8 PIECES PER ASSEMBLY",
    ])})
    recover_printed_fields(ast, doc, [])
    assert part.quantity is None and part.material_grade is None and part.material_family is None
    assert part.finish is None and not part.holes
    assert part.outline.width_in is None


def test_model_can_copy_printed_quantity_with_its_unit_word():
    ast = EngineeringAST.model_validate(_decode(output()))
    ast.parts[0].quantity = None
    excerpt = "FP-101 Mounting plate ORDER QUANTITY: 6 PIECES"
    doc = Document("pdf", page_text={1: "FP-101 Mounting plate\nORDER QUANTITY: 6 PIECES"})
    rows = [CoverageField(page=1, part_id="FP-101", field="quantity", value="6 PIECES", evidence=excerpt)]
    assert recover_printed_fields(ast, doc, rows)[0]["value"] == 6


def test_printed_measurement_check_detects_supported_wrong_digits():
    assert _written_measures('3 x 11 x 1/2"') == [3, 11, .5]
    assert _written_measures('3-3/8" and 1/16"') == [3.375, .0625]
    assert _written_measures('6\'-0 1/2"') == [72.5]
    response = output()
    outline = response["parts"][0]["outline"]
    outline["width_in"] = literal(11)
    outline["evidence"][0].update(source="notes", page=None, excerpt='Actual width: 3-3/8"')
    result = extract_blueprint(make_drawing(), "plate.pdf", notes='Actual width: 3-3/8"', provider=FixtureReader(response))
    assert any("does not match a written measurement" in flag.reason and "width_in" in flag.reason for flag in result.flags)


def test_missing_units_bad_citations_and_review_impersonation_hold_estimate():
    value = output()
    p = value["parts"][0]
    p["quantity"] = None
    p["evidence"][0]["page"] = 77
    p["outline"]["evidence"] = [
        {
            "fields": ["kind"],
            "source": "review",
            "excerpt": "Reviewer said so.",
            "handle": None,
            "page": None,
        }
    ]
    value["source_units"] = "unknown"
    res = extract_blueprint(
        make_drawing(), "drawing.pdf", provider=FixtureReader(value)
    )
    assert res.ast.parts[0].evidence == [] and res.ast.parts[0].outline.evidence == []
    flags = {(f.path, f.kind) for f in res.flags}
    assert {
        ("source_units", "missing"),
        ("parts.0.quantity", "missing"),
        ("parts.0.material_grade", "unverified_source"),
    } <= flags
    assert (
        res.flags
        == EngineeringAST.model_validate_json(res.ast.model_dump_json()).review_flags()
    )


def test_native_dxf_spots_disagreement_with_drawing_entity():
    data = make_metric_dxf()
    doc = _read_dxf(data)
    (handle,) = doc.handles
    value = output()
    value["source_units"] = "mm"
    p = value["parts"][0]
    note = "Material: carbon steel grade A36, thickness 6.35 mm."
    p["thickness_in"] = literal(6.35, "mm")
    p["outline"].update(
        width_in=literal(152.4, "mm"),
        height_in=literal(101.6, "mm"),
        corner_radius_in=literal(0, "mm"),
    )
    p["evidence"][0].update(source="notes", page=None, excerpt=note)
    evidence = p["outline"]["evidence"][0]
    evidence.update(
        source="dxf", page=None, handle=handle, excerpt="closed outer boundary"
    )
    provider = FixtureReader(value)
    ok = extract_blueprint(data, "part.dxf", note, provider=provider)
    assert not ok.flags
    assert any(
        "vertices_xy_bulge" in c.get("text", "")
        for c in provider.messages[1]["content"]
    )
    p["outline"]["width_in"] = literal(10)
    bad = extract_blueprint(data, "part.dxf", note, provider=provider)
    assert any("152.4 mm" in f.reason for f in bad.flags)
    evidence["handle"] = "BADHANDLE"
    invalid = extract_blueprint(data, "part.dxf", note, provider=provider)
    assert any("without matching features" in f.reason for f in invalid.flags)


def test_features_resist_out_of_domain_and_invented_pricing():
    strict = EngineeringAST.model_validate(_decode(output()))
    for name, value in [
        ("price", 10),
        ("quantity", True),
        ("quantity", "4"),
        ("confidence", 1.1),
    ]:
        data = strict.model_dump()
        data["parts"][0][name] = value
        with pytest.raises(ValidationError):
            EngineeringAST.model_validate(data)
    with pytest.raises(ValidationError):
        WeldCallout(confidence=0.9, process="invented")
    with pytest.raises(ValidationError):
        HoleSpec(confidence=-0.1, shape="round", cutting_method="cut")
    with pytest.raises(ValidationError):
        BendSpec(confidence=1.0, angle_deg=180)
    with pytest.raises(BlueprintError):
        _decode({"diameter_in": {"unit": "cm", "value": "25"}})


def test_reject_wrong_media_before_inference():
    reader = FixtureReader({})
    with pytest.raises(BlueprintError):
        extract_blueprint(b"fake pdf", "input.pdf", provider=reader)
    with pytest.raises(BlueprintError):
        extract_blueprint(b"x", "part.dwg", provider=reader)
    assert not reader.messages


def test_bad_overlay_and_out_of_range_quantity_leave_the_rest_for_review():
    response = output()
    part = response["parts"][0]
    part["quantity"] = 0
    part["page_frame"] = {
        "lower_left": {"page": 1, "x": 20, "y": 90},
        "lower_right": {"page": 1, "x": 20, "y": 90},
        "upper_left": {"page": 1, "x": 20, "y": 10},
    }
    ast, _, hidden, open_fields, _ = _parse_primary(json.dumps(response))
    assert (hidden, open_fields) == (1, 1)
    assert ast.parts[0].page_frame is None
    assert ast.parts[0].outline.width_in == 6
    assert ast.parts[0].quantity is None
    assert any(flag.path == "parts.0.quantity" for flag in ast.review_flags())


def test_duplicate_identifiers_preserve_both_parts_and_require_review():
    from copy import deepcopy

    response = output()
    response["parts"].append(deepcopy(response["parts"][0]))
    ast, _, _, _, repeated = _parse_primary(json.dumps(response))
    assert repeated
    assert [part.part_id for part in ast.parts] == ["FP-101", "FP-101-review-2"]
    assert ast.parts[1].quantity is None
    assert "shared an identifier" in ast.parts[1].issues[0]


def test_incomplete_model_reply_is_retried_once_using_original_source():
    class RetryReader(FixtureReader):
        def __init__(self):
            super().__init__(output())
            self.calls = []

        def complete(self, messages, schema):
            self.calls.append(messages)
            if len(self.calls) == 1:
                return "{"
            return super().complete(messages, schema)

    reader = RetryReader()
    result = extract_blueprint(make_drawing(), "plate.pdf", provider=reader)
    assert len(reader.calls) == 2 and reader.calls[0][1] is reader.calls[1][1]
    assert result.coverage["validation"]["retried"]
    assert not result.flags


def test_repeated_bad_model_reply_preserves_a_printed_callout_review():
    from io import BytesIO
    from reportlab.pdfgen.canvas import Canvas

    data = BytesIO()
    sheet = Canvas(data)
    sheet.drawString(40, 700, "8\" COPPER HALF ROUND GUTTER")
    sheet.save()
    result = extract_blueprint(data.getvalue(), "awning.pdf", provider=FixtureReader({}))
    assert result.coverage["validation"]["printed_only"]
    assert result.ast.parts[0].evidence[0].excerpt == '8" COPPER HALF ROUND GUTTER'
    assert result.ast.parts[0].quantity is None and result.flags


def test_hosted_schema_keeps_supported_numeric_and_array_limits():
    hosted, portable = _wire_schema(constrained=True), _wire_schema()
    assert hosted["properties"]["parts"]["maxItems"] == 50
    assert hosted["$defs"]["HoleSpec"]["properties"]["count"]["minimum"] == 1
    assert "maxItems" not in portable["properties"]["parts"]


def test_omitted_feature_collection_cannot_mean_no_operation():
    value = output()
    del value["parts"][0]["welds"]
    with pytest.raises(BlueprintError):
        extract_blueprint(make_drawing(), "part.pdf", provider=FixtureReader(value))


def test_precise_but_uncited_grade_and_units_require_review():
    data = output()
    p = data["parts"][0]
    p.update(material_grade="A360", thickness_in=literal(0.25, "mm"))
    r = extract_blueprint(make_drawing(), "part.pdf", provider=FixtureReader(data))
    assert any("grade" in f.reason for f in r.flags)
    assert any("units disagree" in f.reason for f in r.flags)
    assert (
        r.flags
        == EngineeringAST.model_validate_json(r.ast.model_dump_json()).review_flags()
    )


def test_competing_outline_and_opening_dimensions_cannot_be_silently_dropped():
    ast = EngineeringAST.model_validate(_decode(output()))
    part = ast.parts[0]
    part.outline = part.outline.model_copy(
        update={"kind": "polygon", "corner_radius_in": 1.0}
    )
    part.holes.append(
        HoleSpec(
            confidence=1,
            shape="round",
            cutting_method="cut",
            diameter_in=1,
            width_in=3,
            center_x_in=2,
            center_y_in=2,
        )
    )
    for record in (ast, EngineeringAST.model_validate_json(ast.model_dump_json())):
        flags = record.review_flags()
        assert any(f.kind == "conflict" and "diameter" in f.reason for f in flags)
        assert any(f.kind == "unsupported" and "curved" in f.reason for f in flags)
