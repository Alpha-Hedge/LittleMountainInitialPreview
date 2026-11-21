import base64
import io
from copy import deepcopy

from pypdf import PdfReader

from packages.ai.blueprint_extractor import _decode, render_blueprint_preview
from packages.ai.examples.blueprint_demo import make_drawing
from packages.ai.schemas import EngineeringAST
from packages.ai.tests.test_blueprint import output
from packages.cad.cost_engine import demo_settings
from packages.cad.review_proof import blueprint_proof, rectangular_views, sketch_proof
from packages.cad.tests.test_sketch_pipeline import annotation, rectangle

EVIDENCE = {"registration": {"size": [1000, 1000]}, "candidates": []}


def test_edits_rebuild_geometry_and_weld_text_without_releasing_or_mutating_source():
    reading = rectangle()
    reading["parts"][0]["annotations"].append(
        annotation("weld", "1/8 fillet", "E2", score=0.84)
    )
    initial = deepcopy(reading)
    a = sketch_proof(reading, 2, EVIDENCE, [])
    assert (
        a["issues"]
        and a["dxfs"]
        and a["geometry"][0]["bounds"] == (0.0, 0.0, 10.0, 8.0)
    )
    assert reading == initial
    marks = reading["parts"][0]["annotations"]
    marks[0] = annotation("width", "12")
    marks[-1] = annotation("weld", "3/16 fillet", "E2")
    b = sketch_proof(reading, 2, EVIDENCE, [])
    assert not b["issues"] and b["geometry"][0]["bounds"] == (0.0, 0.0, 12.0, 8.0)
    assert (
        "3/16 fillet"
        in PdfReader(io.BytesIO(base64.b64decode(b["pdf"]))).pages[0].extract_text()
    )
    marks.append(annotation("width", "9"))
    conflict = sketch_proof(reading, 2, EVIDENCE, [])
    assert conflict["issues"] and not conflict["dxfs"] and not conflict["pdf"]


def test_pdf_view_registration_and_written_dimensions_independent_of_page_pixels():
    data = output()
    data["parts"][0]["outline"]["field_locations"] = [
        {"field": "width_in", "location": {"page": 1, "x": 500, "y": 180}}
    ]
    ast = EngineeringAST.model_validate(_decode(data))
    proof = blueprint_proof(ast, demo_settings(), "Fixture", 1)
    assert (
        proof["geometry"][0]["bounds"] == (0.0, 0.0, 6.0, 4.0)
        and len(proof["dxfs"]) == 1
    )
    image, _ = render_blueprint_preview(make_drawing(), True, 1)
    assert any(abs(r[-1] - 1.5) < 0.03 for r in rectangular_views(image))


def test_source_stamp_does_not_change_valid_cad_proof():
    ast = EngineeringAST.model_validate(_decode(output()))
    reference = blueprint_proof(ast, demo_settings(), "Fixture", 1)
    ast.source_release_hold = "Page 1 is marked not for construction or fabrication."
    stamped = blueprint_proof(ast, demo_settings(), "Fixture", 1)
    assert stamped["geometry"] and stamped["dxfs"]
    assert stamped["geometry"] == reference["geometry"]
    assert stamped["dxfs"] == reference["dxfs"]
    assert stamped["issues"] == reference["issues"]
