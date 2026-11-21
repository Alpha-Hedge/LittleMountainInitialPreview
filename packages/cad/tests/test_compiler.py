import csv
import io
import json
from copy import deepcopy
from math import pi
from pathlib import Path

import ezdxf
import pytest
from ezdxf import bbox
from pypdf import PdfReader

from packages.cad.bridge import process
from packages.cad.dxf_compiler import compile_drawing


@pytest.fixture
def drawing():
    return json.loads((Path(__file__).parents[1] / "examples/slotted-bracket.json").read_text())


def read_dxf(data):
    return ezdxf.read(io.TextIOWrapper(io.BytesIO(data), encoding="utf-8"))


def test_independent_artifact_measurements(drawing):
    docs = compile_drawing(drawing)
    dxf = read_dxf(docs.dxfs[0])
    audit = dxf.audit()
    assert not audit.errors and not audit.fixes
    assert dxf.header["$INSUNITS"] == 4
    assert tuple(dxf.header["$EXTMIN"]) == (0, 0, 0)
    assert tuple(dxf.header["$EXTMAX"]) == (120, 80, 0)
    assert {layer.dxf.name for layer in dxf.layers} >= {
        "0_CUT_OUTER",
        "1_CUT_INNER",
        "2_SCRIBE_ETCH",
        "3_REF_ONLY",
    }
    outer, circle, slot, bend = dxf.modelspace()
    assert all(e.closed and e.dxftype() == "LWPOLYLINE" for e in [outer, circle, slot])
    assert [e.dxf.layer for e in (outer, circle, slot, bend)] == [
        "0_CUT_OUTER",
        "1_CUT_INNER",
        "1_CUT_INNER",
        "2_SCRIBE_ETCH",
    ]
    assert [e.dxftype() for e in circle.virtual_entities()] == ["ARC", "ARC"]
    assert all(
        tuple(e.dxf.center) == (22, 40, 0) and e.dxf.radius == 5 for e in circle.virtual_entities()
    )
    slot_box = bbox.extents([slot])
    assert tuple(slot_box.extmin) == pytest.approx((51, 35, 0))
    assert tuple(slot_box.extmax) == pytest.approx((87, 45, 0))
    assert bend.dxftype() == "LINE" and tuple(bend.dxf.end) == (120, 15, 0)
    pdf = PdfReader(io.BytesIO(docs.pdf))
    assert docs.part_pages == [1] and len(pdf.pages) == 1
    assert tuple(pdf.pages[0].mediabox) == (0, 0, 1224, 792)
    text = pdf.pages[0].extract_text()
    for caption in ["MB-014", "Return flange", "Hole to slot center", "47 +0.2/-0.2 mm", "120 mm"]:
        assert caption in text
    (line,) = csv.DictReader(io.StringIO(docs.csv.decode()))
    area = 120 * 80 - (4 - pi) * 4**2 - pi * 5**2 - (26 * 10 + pi * 5**2)
    cut = 2 * (120 + 80) - 8 * 4 + 2 * pi * 4 + pi * 10 + 2 * 26 + pi * 10
    assert float(line["Net area per piece (units^2)"]) == pytest.approx(area)
    assert float(line["Nominal cut length per piece (units)"]) == pytest.approx(cut)
    assert float(line["Net mass per piece (kg)"]) == pytest.approx(area * 6 * 8000 / 1e9)
    assert line["Pierces per piece"] == "3" and line["Bends per piece"] == "1"


def test_kerf_keeps_blueprint_nominal(drawing):
    drawing["kerf_width"] = 1
    docs = compile_drawing(drawing)
    outer, circle, slot, _ = read_dxf(docs.dxfs[0]).modelspace()
    assert tuple(bbox.extents([outer]).extmin) == pytest.approx((-0.5, -0.5, 0))
    assert tuple(bbox.extents([outer]).extmax) == pytest.approx((120.5, 80.5, 0))
    assert next(circle.virtual_entities()).dxf.radius == pytest.approx(4.5)
    assert tuple(bbox.extents([slot]).extmin) == pytest.approx((51.5, 35.5, 0))
    pdf = PdfReader(io.BytesIO(docs.pdf)).pages[0].extract_text()
    assert "120 mm" in pdf and "Kerf 1 mm" in pdf


def test_deterministic_release_and_embedded_path_metadata(drawing):
    a = compile_drawing(drawing)
    assert a == compile_drawing(deepcopy(drawing))
    nominal = read_dxf(a.dxfs[0])
    assert nominal.ezdxf_metadata()["TOOLPATH_MODE"] == "NOMINAL"
    drawing["kerf_width"] = 1
    compensated = read_dxf(compile_drawing(drawing).dxfs[0])
    assert compensated.ezdxf_metadata()["TOOLPATH_MODE"] == "KERF_COMPENSATED"
    assert compensated.header["$USERR1"] == 1 and compensated.header["$INSUNITS"] == 4
    assert nominal.header["$VERSIONGUID"] != compensated.header["$VERSIONGUID"]


def test_shallow_angle_tangencies_use_exact_arcs(drawing):
    from math import cos, radians, sin

    p = drawing["parts"][0]
    # Two intersecting circles at a direction between polygon sampling stations.
    # The overlap is smaller than the inscribed polygon's chord sagitta.
    angle = radians(1)
    p.update(
        bends=[],
        dimensions=[],
        holes=[
            {"shape": "round", "center": {"x": 22, "y": 40}, "diameter": 10},
            {
                "shape": "round",
                "center": {"x": 22 + 9.99998 * cos(angle), "y": 40 + 9.99998 * sin(angle)},
                "diameter": 10,
            },
        ],
    )
    with pytest.raises(ValueError, match="touch or overlap"):
        compile_drawing(drawing)
    # A hole just outside its permitted radius at a rounded corner.
    p["outline"]["corner_radius"] = 20
    p["holes"] = [
        {
            "shape": "round",
            "diameter": 10,
            "center": {"x": 20 - 15.00001 * cos(angle), "y": 20 - 15.00001 * sin(angle)},
        }
    ]
    with pytest.raises(ValueError, match="fully inside"):
        compile_drawing(drawing)


def test_concave_offset_has_physical_clearance(drawing):
    p = drawing["parts"][0]
    coords = [(0, 0), (20, 0), (20, 20), (15, 20), (15, 10), (5, 10), (5, 20), (0, 20)]
    p.update(
        outline={"kind": "polygon", "vertices": [{"x": x, "y": y} for x, y in coords]},
        bends=[],
        dimensions=[],
        holes=[],
    )
    drawing["kerf_width"] = 1
    dxf = read_dxf(compile_drawing(drawing).dxfs[0])
    assert tuple(dxf.header["$EXTMIN"]) == (-0.5, -0.5, 0)
    assert tuple(dxf.header["$EXTMAX"]) == (20.5, 20.5, 0)
    # Left web now sits exactly at the tool diameter from a nonadjacent edge.
    coords[5], coords[6] = (1, 10), (1, 20)
    p["outline"]["vertices"] = [{"x": x, "y": y} for x, y in coords]
    with pytest.raises(ValueError, match="nonadjacent"):
        compile_drawing(drawing)


def test_imperial_and_signed_polygon(drawing):
    drawing["units"] = "in"
    p = drawing["parts"][0]
    p.update(
        holes=[],
        bends=[],
        dimensions=[],
        outline={
            "kind": "polygon",
            "vertices": [
                {"x": -2, "y": -1},
                {"x": -2, "y": 3},
                {"x": 4, "y": 3},
                {"x": 4, "y": -1},
                {"x": -2, "y": -1},
            ],
        },
    )
    drawing["kerf_width"] = 0.02
    doc = read_dxf(compile_drawing(drawing).dxfs[0])
    assert doc.units == 1
    assert tuple(bbox.extents(doc.modelspace()).extmin) == pytest.approx((-2.01, -1.01, 0))
    (outer,) = doc.modelspace()
    assert len(list(outer.virtual_entities())) == 8


def test_multipart_pages_and_formula_cells(drawing):
    p = drawing["parts"][0]
    p["notes"] = "\n".join([f"Instruction {n}" for n in range(40)])
    q = deepcopy(p)
    q.update(part_id="B", notes='=HYPERLINK("x")', density_kg_m3=None)
    drawing["parts"].append(q)
    docs = compile_drawing(drawing)
    pdf = PdfReader(io.BytesIO(docs.pdf))
    assert docs.part_pages == [2, 4] and len(docs.dxfs) == 2
    assert "PART INDEX" in pdf.pages[0].extract_text()
    assert "Instruction 39" in pdf.pages[2].extract_text()
    assert "HYPERLINK" in pdf.pages[docs.part_pages[1] - 1].extract_text()
    line = list(csv.DictReader(io.StringIO(docs.csv.decode())))[1]
    assert line["Notes"].startswith("'=") and line["Net mass per piece (kg)"] == ""


def test_checked_parts_can_share_a_sheet_without_changing_cut_files(drawing):
    first = drawing["parts"][0]
    first.update(notes="", dimensions=[])
    drawing["kerf_width"] = 1
    single = compile_drawing(drawing)
    second = deepcopy(first)
    second.update(part_id="B", name="Second flat blank")
    drawing["parts"].append(second)
    pair = compile_drawing(drawing)
    assert pair.part_pages == [1, 1]
    pdf = PdfReader(io.BytesIO(pair.pdf))
    assert len(pdf.pages) == 1
    assert "Second flat blank" in pdf.pages[0].extract_text()
    assert "DXF kerf 1 mm" in pdf.pages[0].extract_text()
    first_dxf, paired_dxf = (read_dxf(bundle.dxfs[0]) for bundle in (single, pair))
    assert first_dxf.header["$INSUNITS"] == paired_dxf.header["$INSUNITS"] == 4
    assert [list(e.get_points("xyseb")) for e in first_dxf.modelspace().query("LWPOLYLINE")] == [
        list(e.get_points("xyseb")) for e in paired_dxf.modelspace().query("LWPOLYLINE")
    ]
    assert not paired_dxf.audit().errors


@pytest.mark.parametrize(
    "case",
    [
        "cross",
        "duplicate",
        "hole_tangent",
        "hole_overlap",
        "nonfinite",
        "zero",
        "bend_overlap",
        "bend_hole",
        "bend_outside",
        "conflicting_annotation",
        "unsupported_units",
        "kerf_collapse",
        "kerf_neck",
        "extra_field",
    ],
)
def test_refused_geometry(drawing, case):
    p = drawing["parts"][0]
    if case in {"cross", "duplicate", "kerf_neck"}:
        points = {
            "cross": [(0, 0), (1, 1), (1, 0), (0, 1)],
            "duplicate": [(0, 0), (10, 0), (10, 0), (0, 10)],
            "kerf_neck": [
                (0, 0),
                (10, 0),
                (10, 10),
                (5.25, 10),
                (5.25, 5),
                (4.75, 5),
                (4.75, 10),
                (0, 10),
            ],
        }[case]
        p.update(
            outline={"kind": "polygon", "vertices": [{"x": x, "y": y} for x, y in points]},
            holes=[],
            bends=[],
            dimensions=[],
        )
        drawing["kerf_width"] = 1 if case == "kerf_neck" else 0
    elif case == "hole_tangent":
        p["holes"][0]["center"]["x"] = 5
    elif case == "hole_overlap":
        p["holes"][0]["center"]["x"] = 51
    elif case == "nonfinite":
        p["holes"][0]["center"]["x"] = float("nan")
    elif case == "zero":
        p["thickness"] = 0
    elif case == "bend_overlap":
        p["bends"] *= 2
    elif case == "bend_hole":
        for k in ("start", "end"):
            p["bends"][0][k]["y"] = 40
    elif case == "bend_outside":
        p["bends"][0]["end"]["x"] = 125
    elif case == "conflicting_annotation":
        p["dimensions"][0]["value"] = 48
    elif case == "unsupported_units":
        drawing["units"] = "cm"
    elif case == "kerf_collapse":
        drawing["kerf_width"] = 10
    else:
        p["default_tolerance"] = 0.25
    with pytest.raises(ValueError):
        compile_drawing(drawing)


def test_web_contract(drawing):
    s = {
        "name": "Plate",
        "material": "Steel",
        "quantity": 2,
        "thickness": 0.25,
        "notes": "",
        "outline": {
            "kind": "rectangle",
            "width": 6,
            "height": 4,
            "cornerRadius": 0.25,
            "vertices": [],
        },
        "holes": [{"shape": "round", "centerX": 1, "centerY": 1, "diameter": 0.5}],
        "bendLines": [{"label": "Fold A", "start": {"x": 0, "y": 2}, "end": {"x": 6, "y": 2}}],
    }
    payload = {"draft": {"title": "Imperial fixture", "units": "in", "parts": [s]}, "revision": 3}
    assert process({**payload, "format": "validate"})["content"] == ""
    assert process({**payload, "format": "preview"})["parts"][0]["bends"][0]["label"] == "Fold A"
    bundle = process({**payload, "format": "bundle"})
    assert bundle["partPages"] == [1] and len(bundle["dxfs"]) == 1
    for mode in ("csv", "pdf", "dxf"):
        assert process({**payload, "format": mode, "part": 0})["content"]
    with pytest.raises(ValueError):
        process({**payload, "format": "dxf", "part": -1})
