import csv
import io
import math
import json
from copy import deepcopy

import cv2
import ezdxf
import numpy as np
import pytest
from PIL import Image
from pypdf import PdfReader
from pydantic import ValidationError

from packages.ai.sketch_parser import PagePoint, SketchMap, parse_sketch
from packages.ai.assembly_reader import AssemblyReading
from packages.ai.sketch_audit import audit_sketch
from packages.cad.constraint_solver import cited_value, hole_callout, measurement, solve_sketch
from packages.cad.dxf_compiler import compile_solved_sketch
from packages.cad.presentation_sheet import (
    assembly_top_view, make_presentation_sheet, presentation_png, primary_detail,
    saved_illustration, written_callouts,
)
from packages.cad.sketch_draft import make_sketch_draft
from packages.cad.sketch_rectifier import image_format, rectify_sketch
from packages.cad.geometry import DraftProfile, solve_part
from packages.cad.schema import Point as CadPoint, PolygonOutline, RoundHole, Slot
from packages.cad.sketch_verification import disputed_rod_layout, edge_clearance, sketch_evidence


def point(x, y):
    return {"x": x, "y": y}


def annotation(kind, value, *targets, evidence=None, score=1):
    return {
        "kind": kind,
        "value": value,
        "evidence": evidence or value,
        "targets": list(targets or ("P",)),
        "confidence": score,
        "at": point(250, 177),
    }


def rectangle():
    return {
        "title": "Fixture bracket",
        "units": "in",
        "unit_evidence": "Inches",
        "unit_confidence": 1,
        "questions": [],
        "dismissed": [],
        "parts": [
            {
                "name": "Mounting plate",
                "part_id": "PL1",
                "shape": "rectangle",
                "candidate": None,
                "confidence": 1,
                "vertices": [point(100, 710), point(867, 684), point(880, 220), point(106, 210)],
                "holes": [],
                "bends": [],
                "questions": [],
                "annotations": [
                    annotation("width", "10"),
                    annotation("height", "8"),
                    annotation("radius", "square"),
                    annotation("material", "A36 plate"),
                    annotation("thickness", "¼"),
                    annotation("quantity", "2"),
                ],
            }
        ],
    }


def solve(data, **kw):
    return solve_sketch(data, (1000, 1000), **kw)


def test_draft_keeps_written_geometry_with_open_details():
    data = rectangle()
    part = data["parts"][0]
    part["annotations"] = part["annotations"][:2]
    part["holes"] = [
        {"shape": "round", "at": point(200, 250), "confidence": 0.8, "candidate": None},
        {"shape": "round", "at": point(600, 250), "confidence": 1, "candidate": None},
    ]
    part["annotations"] += [
        annotation("x", "8", "H2"), annotation("y", "3", "H2"),
        annotation("diameter", '1/2"', "H1", "H2"),
    ]
    solution = solve(data, draft=True)
    plan, = solution.draft_plans
    assert solution.drawing is None and not solve(data).drawing
    assert plan.geometry.bounds == (0, 0, 10, 8)
    assert plan.hole_labels == ["H2"] and plan.omitted == ["H1"] and plan.corner_open
    assert plan.geometry.part.holes[0].center.xy == (8, 3)
    assert any(pin.field == "material" for pin in solution.pins)
    with pytest.raises(ValueError, match="Resolve the drawing pins"):
        compile_solved_sketch(solution)


def test_draft_pdf_includes_partial_plan_open_checks_and_source():
    evidence = {"registration": {"size": (1000, 1000)}, "candidates": []}
    picture = io.BytesIO()
    Image.new("RGB", (120, 90), "white").save(picture, "JPEG")
    data = rectangle()
    data["parts"][0]["annotations"] = data["parts"][0]["annotations"][:2]
    data["parts"][0]["annotations"].append(annotation("note", 'Check 2½" spacing'))
    result = PdfReader(io.BytesIO(make_sketch_draft(SketchMap.model_validate(data), 1, evidence, picture.getvalue())))
    text = result.pages[0].extract_text()
    assert "DRAFT DRAWING" in text and "DIMENSIONED PLAN" in text
    assert "10 in" in text and "8 in" in text and "Enter quantity" in text and "Square corners" not in text
    assert 'Check 2 1/2" spacing' in text
    assert len(result.pages) == 1
    data["parts"][0]["annotations"] = data["parts"][0]["annotations"][:1]
    result = PdfReader(io.BytesIO(make_sketch_draft(SketchMap.model_validate(data), 2, evidence, picture.getvalue())))
    text = result.pages[0].extract_text()
    assert "SOURCE REFERENCE" in text and "NOT TO SCALE" in text
    assert "DIMENSIONED PLAN" not in text and "Enter material" in text


def test_assembly_overview_shares_a_sheet_with_the_dimensioned_detail():
    evidence = {"registration": {"size": (1000, 1000)}, "candidates": []}
    picture = io.BytesIO()
    Image.new("RGB", (120, 90), "white").save(picture, "JPEG")
    assembly = AssemblyReading.model_validate({
        "members": [
            {"kind": "plate", "label": "Rear plate",
             "faces": [{"corners": [point(45, 200), point(400, 220), point(400, 300), point(45, 280)]}],
             "callout": "10 inch wide"},
            {"kind": "bar", "label": "Projecting bar",
             "faces": [{"corners": [point(100, 260), point(150, 260), point(290, 420), point(240, 420)]}],
             "callout": "32 inches, confirm length"},
        ],
        "hardware": [{"kind": "rod", "label": "Threaded rod", "callout": '3/8" rod',
                      "marks": [{"at": point(210, 360), "tip": point(210, 340)}]}],
        "open_details": ["Confirm the bar attachment."],
    })
    pdf = make_sketch_draft(SketchMap.model_validate(rectangle()), 4, evidence, picture.getvalue(), assembly=assembly)
    pages = [page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages]
    assert all(text in pages[0] for text in ("Assembly overview", "NOT TO SCALE", "Rear plate", "Projecting bar", "Threaded rod", "Confirm the bar attachment."))
    assert len(pages) == 1
    assert "DIMENSIONED PLAN" in pages[0] and "10 in" in pages[0]


def test_sketch_scan_accepts_one_page_and_preserves_preview_coordinates():
    from reportlab.pdfgen.canvas import Canvas
    from packages.cad.sketch_rectifier import sketch_format

    def scanned(pages):
        stream = io.BytesIO()
        document = Canvas(stream, pagesize=(396, 288))
        for _ in range(pages):
            document.rect(70, 70, 250, 150)
            document.showPage()
        document.save()
        return stream.getvalue()

    single = scanned(1)
    assert sketch_format(single) == "application/pdf"
    page = rectify_sketch(single)
    assert page.registration["original_size"][0] == 2200
    assert page.candidates
    with pytest.raises(ValueError, match="one-page sketch PDF"):
        sketch_format(scanned(2))


def test_written_plural_hole_diameter_retains_explicit_centers():
    assert hole_callout('7/8" holes', "in") == (None, 0.875)
    assert hole_callout("4X Ø0.50 THRU", "in") == (4, 0.5)
    data = rectangle()
    part = data["parts"][0]
    for i, x in enumerate((2, 5, 8), 1):
        part["holes"].append({"shape": "round", "at": point(i * 200, 350), "confidence": 1, "candidate": None})
        part["annotations"] += [annotation("x", str(x), f"H{i}"), annotation("from_top", '3/4"', f"H{i}")]
    part["annotations"].append(annotation("hole_callout", '7/8" holes', "H1", "H2", "H3"))
    result = solve(data)
    assert not result.pins
    assert [h.diameter for h in result.drawing.parts[0].holes] == [0.875] * 3
    part["annotations"][-1].update(value='4X 7/8" holes', evidence='4X 7/8" holes')
    assert any("specifies 4" in pin.message for pin in solve(data).pins)


def test_concept_sheet_combines_the_art_with_source_dimensions_and_labels():
    data = rectangle()
    part = data["parts"][0]
    for i, x in enumerate((2, 5, 8), 1):
        part["holes"].append({"shape": "round", "at": point(i * 200, 350), "confidence": 1, "candidate": None})
        part["annotations"] += [annotation("x", str(x), f"H{i}"), annotation("from_top", '3/4"', f"H{i}")]
    part["annotations"] += [
        annotation("hole_callout", '7/8" holes', "H1", "H2", "H3"),
        annotation("note", '3/4" anchors (Titen or epoxy set threaded rod)'),
        annotation("note", "Engineering required"),
    ]
    reading = SketchMap.model_validate(data)
    solution = solve(reading, draft=True)
    detail = primary_detail(reading, solution)
    callouts = written_callouts(reading, detail)
    picture = io.BytesIO()
    Image.new("RGB", (750, 400), "white").save(picture, "PNG")
    pdf = make_presentation_sheet(reading, 8, picture.getvalue(), solution, detail, callouts,
                                  {"detail": PagePoint(x=790, y=300)})
    page, = PdfReader(io.BytesIO(pdf)).pages
    sheet = page.extract_text()
    assert all(value in sheet for value in (
        "AI CONCEPT DRAWING", "ENGINEERING REQUIRED", "DO NOT FABRICATE",
        "PLATE DETAIL", "10\"", "7/8\"", "3/4\"", "Titen", "8  /  in",
    ))
    # A model-supplied pin cannot create new caption text and off-image notes remain readable.
    assert len(page.images) == 1
    with Image.open(io.BytesIO(presentation_png(pdf))) as png:
        assert png.width >= 1900 and png.height >= 1200
    with Image.open(io.BytesIO(saved_illustration(pdf))) as art:
        assert art.size == (750, 400)


@pytest.mark.parametrize("as_note", [False, True])
def test_bar_assembly_plan_uses_written_face_width_and_keeps_unlocated_spacing_open(as_note):
    data = rectangle()
    base = data["parts"][0]
    base["annotations"].extend([annotation("note", "Mounting plate thickness may increase")])
    bars = deepcopy(base)
    section = '1" x 3" Bar'
    stock = [annotation("note", section + ' @ ≈ 32"')] if as_note else [
        annotation("width", '3"', evidence=section), annotation("thickness", '1"', evidence=section),
    ]
    bars.update(name="Bars in assembly", part_id="BAR", shape="unknown", vertices=[],
                annotations=[*stock, annotation("note", '32"')])
    data["parts"].append(bars)
    members = [
        ("plate", [(300, 120), (420, 160), (420, 220), (300, 180)]),
        ("bar", [(410, 220), (430, 232), (220, 386), (198, 374)]),
        ("bar", [(360, 188), (380, 201), (169, 354), (149, 342)]),
    ]
    assembly = AssemblyReading.model_validate({
        "members": [{"kind": kind, "label": kind, "callout": "",
                     "faces": [{"corners": [point(x, y) for x, y in corners]}]}
                    for kind, corners in members],
        "hardware": [{
            "kind": "rod", "label": "Visible rods", "callout": "",
            "marks": [{"at": point(x, y), "tip": None}
                      for x, y in [(310, 302), (265, 264), (350, 202), (700, 740)]],
        }], "open_details": [],
    })
    reading = SketchMap.model_validate(data)
    solution = solve(reading, draft=True)
    detail = primary_detail(reading, solution)
    plan = assembly_top_view(reading, detail, assembly)
    assert plan.face_width == 3 and plan.stock_thickness == 1 and plan.written_length == 32
    assert sorted(map(len, plan.rods)) == [1, 2]
    picture = io.BytesIO()
    Image.new("RGB", (750, 400), "white").save(picture, "PNG")
    sheet = make_presentation_sheet(reading, 3, picture.getvalue(), solution, detail,
                                    written_callouts(reading, detail), {}, assembly=assembly)
    page, = PdfReader(io.BytesIO(sheet)).pages
    text = page.extract_text()
    assert all(label in text for label in ("ASSEMBLY / ISOMETRIC", "ASSEMBLY / TOP VIEW", "ASSEMBLY / SIDE VIEW",
                                           "BAR STOCK / END VIEW", '3"', '1"', '32"',
                                           "Rod count, pitch, offsets and attachment", "EDGE VIEW", "Tentative"))
    rectangles = [tuple(map(float, operands)) for operands, op in page.get_contents().operations if op == b"re"]
    # The two plan faces use their broad dimension, and the aligned side profile uses stock thickness.
    plan_faces = sorted((x, w, h) for x, y, w, h in rectangles if x < 912 and 215 < y < 348 and w > 160)
    side_faces = [(x, w, h) for x, y, w, h in rectangles if 68 < y < 140 and w > 160]
    assert len(plan_faces) == 2 and len(side_faces) == 1
    assert all(face[1] / face[2] == pytest.approx(32 / 3) for face in plan_faces)
    assert side_faces[0][:2] == pytest.approx(plan_faces[0][:2])
    assert side_faces[0][1] / side_faces[0][2] == pytest.approx(32)
    del assembly.members[-1]
    assert assembly_top_view(reading, detail, assembly) is None


def test_sketch_check_keeps_visual_findings_separate_from_the_measured_plate():
    data = rectangle()
    part = data["parts"][0]
    part["holes"].append({"shape": "round", "at": point(200, 250), "confidence": 1, "candidate": None})
    part["annotations"] += [annotation("x", '2"', "H1"),
                            annotation("from_top", '3/4"', "H1"),
                            annotation("diameter", '7/8"', "H1")]
    reading = SketchMap.model_validate(data)
    solution = solve(reading, draft=True)
    ledger = sketch_evidence(reading, solution)
    assert ledger["clearances"][0]["gap"] == .3125
    assert ledger["parts"][0]["plotted"]["openings"][0]["center"]["y"] == 7.25
    image = io.BytesIO()
    Image.new("RGB", (200, 120), "white").save(image, "PNG")

    class Reader:
        model = "fixture"

        def complete(self, messages, schema):
            assert any(block["type"] == "image_url" for block in messages[1]["content"])
            return json.dumps({"findings": [{
                "kind": "hardware", "view": "isometric", "part_id": "PL1",
                "issue": "Verify the depicted washers.",
                "evidence": "The source only specifies a hole.", "confidence": .96, "at": None,
            }]})

    report = audit_sketch(image.getvalue(), ledger, image.getvalue(), provider=Reader())
    assert report["status"] == "checked" and report["findings"][0]["kind"] == "hardware"
    assert audit_sketch(image.getvalue(), ledger, provider=Reader())["findings"] == []
    detail = primary_detail(reading, solution)
    pdf = make_presentation_sheet(reading, 2, image.getvalue(), solution, detail,
                                  written_callouts(reading, detail), {}, audit=report)
    pages = PdfReader(io.BytesIO(pdf)).pages
    assert "SKETCH CHECKS / SHEET 2" in pages[0].extract_text()
    assert "washers" in pages[1].extract_text() and '5/16"' in pages[1].extract_text()
    assert ledger["parts"][0]["plotted"]["openings"][0]["diameter"] == .875


def test_clearance_checks_slot_to_diagonal_edge_without_using_the_bounding_box():
    outline = PolygonOutline(kind="polygon", vertices=[
        CadPoint(x=0, y=0), CadPoint(x=60, y=0), CadPoint(x=60, y=40),
        CadPoint(x=40, y=60), CadPoint(x=0, y=60),
    ])
    profile = DraftProfile(outline=outline, holes=[
        Slot(shape="slot", center=CadPoint(x=45, y=45), width=4, length=14, angle=45),
        RoundHole(shape="round", center=CadPoint(x=10, y=15), diameter=6),
    ])
    result = edge_clearance(solve_part(profile), ["S1", "H1"])
    assert result == {"opening": "S1", "gap": pytest.approx(10 / math.sqrt(2) - 7), "approximate": False}


def test_written_piece_count_accepts_words_but_rejects_a_feature_count():
    data = rectangle()
    marks = data["parts"][0]["annotations"]
    marks[-1] = annotation("quantity", "3 PIECES", evidence="MAKE 3 PIECES")
    assert solve(data).drawing.parts[0].quantity == 3
    marks[-1] = annotation("quantity", "3 holes", evidence="3 holes")
    assert solve(data).drawing is None


def test_view_disagreement_withholds_schematic_rod_locations():
    finding = {"kind": "feature", "view": "across_views", "confidence": .97,
               "issue": "Confirm the rod count before placing the studs."}
    assert disputed_rod_layout({"findings": [finding]})
    assert not disputed_rod_layout({"findings": [{**finding, "view": "isometric"}]})


def test_measured_plate_callout_bends_and_weld_reach_compiler():
    data = rectangle()
    part = data["parts"][0]
    for i, (x, y) in enumerate(((1, 1), (9, 1), (9, 7), (1, 7)), 1):
        part["holes"].append(
            {"shape": "round", "at": point(150 + i * 50, 250 + i * 25), "confidence": 1, "candidate": None}
        )
        part["annotations"].extend(
            [annotation("x", str(x), "H" + str(i)), annotation("y", str(y), "H" + str(i))]
        )
    part["annotations"].append(annotation("hole_callout", "4X 1/2 THRU", "H1", "H2", "H3", "H4"))
    part["bends"].append(
        {"candidate": None, "confidence": 1, "start": point(150, 510), "end": point(798, 501)}
    )
    part["annotations"].extend(
        [
            annotation("x", "0", "B1.a"),
            annotation("y", "4", "B1.a", "B1.b"),
            annotation("x", "10", "B1.b"),
            annotation("bend_angle", "90°", "B1"),
            annotation("bend_direction", "up", "B1"),
            annotation("weld", "1/8 fillet on arrow side", "E2"),
            annotation("note", "Deburr both sides"),
        ]
    )
    solved = solve(data)
    assert not solved.pins
    batch = compile_solved_sketch(solved)
    doc = ezdxf.read(io.TextIOWrapper(io.BytesIO(batch.dxfs[0]), encoding="utf-8", newline=None))
    audit = doc.audit()
    assert not audit.errors and not audit.fixes and doc.header["$INSUNITS"] == 1
    assert tuple(doc.header["$EXTMAX"]) == (10, 8, 0)
    paths = list(doc.modelspace())
    assert len(paths) == 6 and all(p.closed and p.dxftype() == "LWPOLYLINE" for p in paths[:5])
    assert paths[-1].dxf.layer == "2_SCRIBE_ETCH"
    assert [h.center.xy for h in solved.drawing.parts[0].holes] == [(1, 1), (9, 1), (9, 7), (1, 7)]
    assert all(h.diameter == 0.5 for h in solved.drawing.parts[0].holes)
    row = next(csv.DictReader(io.StringIO(batch.csv.decode("utf-8-sig"))))
    assert row["Quantity"] == "2" and row["Pierces per piece"] == "5" and "fillet" in row["Notes"]
    raw = "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(batch.pdf)).pages)
    assert "fillet" in raw and "Deburr both sides" in raw and "PL1" in raw
    # A different hand-drawn aspect ratio yields identical geometry.
    part["vertices"] = [point(11, 856), point(242, 892), point(250, 72), point(10, 79)]
    assert solve(data).drawing == solved.drawing


def test_missing_and_conflict_are_located_and_prevent_output():
    data = rectangle()
    part = data["parts"][0]
    part["annotations"] = [a for a in part["annotations"] if a["kind"] != "height"]
    ans = solve(data)
    assert ans.drawing is None and any(p.field == "height" and p.part_id == "PL1" for p in ans.pins)
    with pytest.raises(ValueError):
        compile_solved_sketch(ans)
    part["annotations"] += [annotation("height", "8"), annotation("height", "9")]
    ans = solve(data)
    assert any(p.code == "conflict" and p.annotation is not None and p.at.x == 250 for p in ans.pins)
    assert ans.drawing is None
    part["annotations"].pop()
    part["annotations"].append(annotation("angle", "10°", "E1"))
    assert any(p.code == "conflict" for p in solve(data).pins)


def test_review_keys_apply_to_exact_evidence_and_only_confidence():
    data = rectangle()
    part = data["parts"][0]
    part["annotations"][0]["confidence"] = 0.84
    pin = solve(data).pins[0]
    assert pin.code == "low_confidence"
    assert solve(data, accepted=[pin.review_key]).drawing
    part["annotations"][0].update(value="20", evidence="20")
    assert solve(data, accepted=[pin.review_key]).drawing is None
    part["annotations"][0]["confidence"] = 0.85
    candidate = {"id": "C4", "anchor": point(30, 30)}
    assert solve(data, candidates=[candidate]).pins[0].code == "unbound"
    data["dismissed"] = [{"ids": ["C4"], "reason": "Printed title block."}]
    assert solve(data, candidates=[candidate]).drawing
    data["unit_evidence"] = "no unit written"
    assert solve(data).drawing is None


def test_engineering_and_tentative_thickness_notes_are_explicit_checks():
    data = rectangle()
    part = data["parts"][0]
    part["annotations"] += [
        annotation("note", "NTS - Engineering Req’d."),
        annotation("note", "might need to increase thickness"),
    ]
    data["questions"].append({"text": "Engineering review is required as noted on the sketch.", "at": point(250, 177)})
    result = solve(data)
    assert result.drawing is None
    assert [pin.code for pin in result.pins] == ["engineering_note", "tentative_thickness"]
    assert solve(data, accepted=[pin.review_key for pin in result.pins]).drawing


def test_polygon_snaps_within_five_and_preserves_explicit_nonorthogonal_side():
    data = rectangle()
    part = data["parts"][0]
    part.update(
        shape="polygon",
        vertices=[
            point(100, 800),
            point(800, 800 - 700 * math.tan(math.radians(4.9))),
            point(790, 180),
            point(96, 199),
        ],
    )
    part["annotations"] = [a for a in part["annotations"] if a["kind"] not in ("width", "height", "radius")]
    part["annotations"] += [annotation("length", "10", "E1"), annotation("length", "8", "E2")]
    ans = solve(data)
    assert not ans.pins
    assert [p.xy for p in ans.drawing.parts[0].outline.vertices] == [(0, 0), (10, 0), (10, 8), (0, 8)]
    part["vertices"] = [point(100, 800), point(800, 800 - 700 * math.tan(math.radians(5.2))), point(710, 296)]
    part["annotations"] = [a for a in part["annotations"] if a["kind"] != "length"]
    part["annotations"] += [
        annotation("x", "10", "V2"),
        annotation("y", "2", "V2"),
        annotation("x", "8", "V3"),
        annotation("y", "7", "V3"),
    ]
    ans = solve(data)
    assert not ans.pins and "E1" not in [s["edge"] for s in ans.snapped_edges]
    assert ans.drawing.parts[0].outline.vertices[1].xy == (10, 2)


def test_triangle_from_three_written_side_lengths():
    data = rectangle()
    part = data["parts"][0]
    part.update(shape="polygon", vertices=[point(150, 800), point(890, 800), point(440, 150)])
    part["annotations"] = [a for a in part["annotations"] if a["kind"] not in ("width", "height", "radius")]
    part["annotations"] += [
        annotation("length", "6", "E1"),
        annotation("length", "5", "E2"),
        annotation("length", "5", "E3"),
    ]
    ans = solve(data)
    assert not ans.pins
    assert [p.xy for p in ans.drawing.parts[0].outline.vertices] == [(0, 0), (6, 0), (3, 4)]


@pytest.mark.parametrize(
    "raw,units,expected",
    [("2⅜ in", "in", 2.375), ('1-1/2"', "mm", 38.1), ("25.4 mm", "in", 1.0), ("-3/8", "in", -0.375)],
)
def test_written_units(raw, units, expected):
    assert measurement(raw, units) == pytest.approx(expected)


def synthetic_photo():
    sheet = np.full((600, 800, 3), 246, np.uint8)
    cv2.rectangle(sheet, (100, 100), (680, 478), (0, 0, 0), 3)
    for pos in ((180, 170), (590, 390)):
        cv2.circle(sheet, pos, 24, (0, 0, 0), 4)
    for x in range(151, 635, 38):
        cv2.line(sheet, (x, 292), (x + 19, 292), (10, 10, 10), 4)
    camera_corners = np.float32([[85, 65], [872, 128], [800, 742], [38, 627]])
    warp = cv2.getPerspectiveTransform(np.float32([[0, 0], [799, 0], [799, 599], [0, 599]]), camera_corners)
    photo = cv2.warpPerspective(sheet, warp, (950, 800), borderValue=(52, 65, 49))
    return cv2.imencode(".png", photo)[1].tobytes(), camera_corners


def test_rectified_photo_and_candidate_evidence():
    raw, corners = synthetic_photo()
    result = rectify_sketch(raw)
    reg = result.registration
    assert reg["page_detected"] and np.allclose(reg["page_corners"], corners, atol=6)
    located = cv2.perspectiveTransform(corners[None], np.array(reg["photo_to_page"]))[0]
    assert np.linalg.norm(located[0]) < 12
    kinds = [c["kind"] for c in result.candidates]
    assert "outer" in kinds and kinds.count("hole") >= 2 and "bend" in kinds
    assert {c["id"] for c in result.candidates} and result.jpeg() != result.jpeg(True)
    assert image_format(raw) == "image/png"
    flat = np.full((400, 420, 3), 255, np.uint8)
    cv2.rectangle(flat, (24, 26), (380, 350), (0, 0, 0), 2)
    assert not rectify_sketch(cv2.imencode(".jpg", flat)[1].tobytes()).registration["page_detected"]


def test_heic_and_alpha_png():
    pillow_heif = pytest.importorskip("pillow_heif")
    pillow_heif.register_heif_opener()
    buf = io.BytesIO()
    Image.new("RGB", (100, 90), "white").save(buf, format="HEIF")
    assert image_format(buf.getvalue()) == "image/heic"
    assert rectify_sketch(buf.getvalue()).photo.shape[:2] == (90, 100)
    buf = io.BytesIO()
    Image.new("RGBA", (90, 80), (10, 15, 10, 0)).save(buf, format="PNG")
    assert rectify_sketch(buf.getvalue()).photo.min() > 250


def test_iphone_orientation_and_registration_use_original_pixel_space():
    image = Image.new("RGB", (80, 120), "white")
    exif = Image.Exif()
    exif[274] = 6
    stream = io.BytesIO()
    image.save(stream, format="JPEG", exif=exif)
    page = rectify_sketch(stream.getvalue())
    assert page.registration["original_size"] == [80, 120]
    assert page.registration["display_size"] == [120, 80]
    assert page.photo.shape[:2] == (80, 120)
    matrix = np.array(page.registration["photo_to_page"])
    assert np.allclose(matrix @ [0, 119, 1], [0, 0, 1])


def test_deskew_and_conflicting_unit_evidence():
    image = np.full((600, 800, 3), 255, np.uint8)
    cv2.rectangle(image, (115, 150), (650, 450), (15, 15, 15), 3)
    cv2.line(image, (120, 370), (616, 370), (20, 20, 20), 3)
    rotated = cv2.warpAffine(
        image, cv2.getRotationMatrix2D((400, 300), 5.5, 1), (800, 600), borderValue=(255, 255, 255)
    )
    page = rectify_sketch(cv2.imencode(".jpg", rotated)[1].tobytes())
    assert abs(page.registration["deskew_deg"]) == pytest.approx(5.5, abs=0.75)
    data = rectangle()
    data["unit_evidence"] = "All dimensions in mm"
    assert solve(data).drawing is None


def test_multipart_release_requires_a_solved_outline_and_written_symmetry():
    data = rectangle()
    other = deepcopy(data["parts"][0])
    other.update(part_id="PL2", shape="unknown")
    data["parts"].append(other)
    assert any(p.code == "topology" and p.part_id == "PL2" for p in solve(data).pins)
    data["parts"].pop()
    part = data["parts"][0]
    part["holes"] = [{"candidate": None, "shape": "round", "confidence": 1, "at": point(409, 392)}]
    part["annotations"].extend(
        [
            annotation("diameter", "1/2", "H1"),
            annotation("center_x", "10", "H1"),
            annotation("center_y", "centered", "H1"),
        ]
    )
    assert any(p.code == "binding" and "symmetry" in p.message for p in solve(data).pins)
    part["annotations"][-2] = annotation("center_x", "centered", "H1")
    assert solve(data).drawing.parts[0].holes[0].center.xy == (5, 4)


def test_source_matching_keeps_fractions_and_ignores_sentence_punctuation():
    assert cited_value("90°", "bend up 90°.")
    assert cited_value("4", "overall height 4.")
    assert not cited_value("4", "overall height 4.5")
    assert not cited_value("1", "hole size 1/2")
    assert not cited_value("2", "hole size 1/2")
    assert not cited_value("1/2", "blank width 2 1/2")
    assert not cited_value("2", "offset -2")
    assert not cited_value("up", "support")


def test_structured_reader_gets_both_images_and_rejects_extra_data():
    rect = rectify_sketch(synthetic_photo()[0])
    schema = SketchMap.model_validate(rectangle())

    class Reader:
        name = "test"
        model = "fixture"

        def complete(self, messages, response_schema):
            images = [part for part in messages[1]["content"] if part["type"] == "image_url"]
            assert len(images) == 2 + len(list(rect.detail_views())) and all(
                part["image_url"]["url"].startswith("data:image/jpeg;base64,") for part in images
            )
            assert response_schema["additionalProperties"] is False
            return schema.model_dump_json()

    assert parse_sketch(rect, Reader()).mapping == schema
    invalid = deepcopy(rectangle())
    invalid["parts"][0]["scale_measured_from_pixels"] = 0.5
    with pytest.raises(ValidationError):
        SketchMap.model_validate(invalid)
