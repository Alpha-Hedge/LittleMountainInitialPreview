"""Audit real source files on the isolated engineering API and an ephemeral Chrome desk."""

import argparse
import base64
import csv
import hashlib
import io
import json
import math
import os
import subprocess
import sys
import tempfile
import traceback
from copy import deepcopy
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import ezdxf
import pypdfium2 as pdfium
from ezdxf.path import make_path
from shapely.geometry import LineString, Polygon

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from packages.ai.schemas import EngineeringAST
from packages.ai.sketch_parser import SketchMap
from packages.cad.constraint_solver import hole_callout, measurement, solve_sketch
from packages.cad.cost_engine import CostSettings
from packages.cad.dxf_compiler import INNER, LAYERS, OUTER, SCRIBE, compile_drawing
from packages.cad.review_proof import blueprint_drawing

SKETCH = {".jpg", ".jpeg", ".png", ".webp", ".heif", ".heic"}
SUPPORTED = SKETCH | {".pdf", ".dxf"}
D = Decimal


class AuditAPI:
    def __init__(self):
        config = dict(
            row.split("=", 1)
            for row in (ROOT / ".env.nfip-test")
            .read_text(encoding="utf-8-sig")
            .splitlines()
            if "=" in row and not row.lstrip().startswith("#")
        )
        self.base = config["NFIP_API_URL"]
        assert self.base == "http://127.0.0.1:8141", (
            "Use the isolated engineering stack on 8141."
        )
        self.token = config["NFIP_API_TOKEN"]

    def call(self, route, payload=None, status=200):
        body = json.dumps(payload).encode() if payload is not None else None
        headers = {
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
        }
        try:
            response = urlopen(Request(self.base + route, body, headers), timeout=75)
        except HTTPError as error:
            response = error
        with response as res:
            raw = res.read()
            data = (
                json.loads(raw)
                if res.headers.get_content_type() == "application/json"
                else raw
            )
            assert res.status == status, (
                f"{route} returned {res.status}; expected {status}. {str(data)[:250]}"
            )
            return data


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def check_close(actual, expected, tolerance=1e-7):
    assert math.isclose(float(actual), float(expected), abs_tol=tolerance, rel_tol=0), (
        actual,
        expected,
    )


def audit_dxf(data, part, units, kerf=0):
    doc = ezdxf.read(io.StringIO(data.decode("utf-8-sig"), newline=None))
    audit = doc.audit()
    assert not audit.errors and not audit.fixes, (
        f"DXF audit found {len(audit.errors)} errors and {len(audit.fixes)} repairs"
    )
    assert b"$INSUNITS" in data and doc.header["$INSUNITS"] == {"in": 1, "mm": 4}[units]
    assert {entry.dxf.name for entry in doc.layers} - {"0", "Defpoints"} == set(LAYERS)
    outer = []
    inner = []
    scribe = []
    # Flatten bulges finely enough to independently check centers and written sizes.
    tolerance = 0.001 if units == "in" else 0.0254
    for entity in doc.modelspace():
        layer = entity.dxf.layer
        assert layer in LAYERS, f"Unexpected entity layer {layer}"
        if layer == SCRIBE:
            assert entity.dxftype() == "LINE"
            segment = LineString([tuple(p) for p in (entity.dxf.start, entity.dxf.end)])
            assert segment.length > 0 and not any(
                segment.intersection(old).length > 1e-9 for old in scribe
            ), "Duplicate or overlapping scribe vector"
            scribe.append(segment)
            continue
        assert layer in {OUTER, INNER}, f"Unexpected model-space geometry on {layer}"
        assert entity.dxftype() == "LWPOLYLINE" and entity.closed
        points = [
            (p.x, p.y) for p in make_path(entity).flattening(tolerance / 30, segments=8)
        ]
        loop = Polygon(points)
        assert loop.is_valid and loop.exterior.is_simple and loop.area > 0
        (outer if layer == OUTER else inner).append(loop)
    assert len(outer) == 1 and len(scribe) == len(part["bends"])
    outline = part["outline"]
    if outline["kind"] == "rectangle":
        x0, y0, x1, y1 = outer[0].bounds
        check_close(x1 - x0 - kerf, outline["width"], tolerance)
        check_close(y1 - y0 - kerf, outline["height"], tolerance)
    else:
        # Use the independent Shapely offset for a polygon with a compensated path.
        nominal = Polygon([(p["x"], p["y"]) for p in outline["vertices"]])
        expected = nominal.buffer(kerf / 2, quad_segs=48) if kerf else nominal
        assert outer[0].hausdorff_distance(expected) <= tolerance
    assert len(inner) == len(part["holes"])
    for i, (hole, loop) in enumerate(zip(part["holes"], inner, strict=True)):
        assert outer[0].contains(loop) and not any(
            loop.intersects(other) for other in inner[:i]
        )
        check_close(loop.centroid.x, hole["center"]["x"], tolerance)
        check_close(loop.centroid.y, hole["center"]["y"], tolerance)
        if hole["shape"] == "round":
            check_close(
                loop.bounds[2] - loop.bounds[0] + kerf, hole["diameter"], tolerance
            )
        else:
            edges = list(loop.minimum_rotated_rectangle.exterior.coords)
            dimensions = sorted(math.dist(a, b) for a, b in pairwise(edges))
            check_close(dimensions[0] + kerf, hole["width"], tolerance)
            check_close(dimensions[-1] + kerf, hole["length"], tolerance)
    return outer[0].area - sum(hole.area for hole in inner)


def audit_shop_pdf(blob, output):
    with pdfium.PdfDocument(blob) as document:
        assert len(document) > 0
        for i, page in enumerate(document):
            assert page.get_size() == (1224, 792), "Expected ANSI B sheet size"
            text = page.get_textpage()
            content = text.get_text_bounded()
            assert all(
                mark in content
                for mark in ("FEATURE SCHEDULE", "PART ID", "REVISION", "SHEET SIZE")
            )
            boxes = []
            for char in range(text.count_chars()):
                try:
                    x0, y0, x1, y1 = text.get_charbox(char)
                except pdfium.PdfiumError:
                    continue
                if x1 - x0 < 0.15 or y1 - y0 < 0.15:
                    continue
                assert 23.9 <= x0 < x1 <= 1200.1 and 23.9 <= y0 < y1 <= 768.1, (
                    i + 1,
                    "visible text outside shop sheet frame",
                    (x0, y0, x1, y1),
                )
                boxes.append((x0, y0, x1, y1))
            widths = sorted(boxes)
            for j, (x0, y0, x1, y1) in enumerate(widths):
                for a, b, c, d in widths[j + 1 :]:
                    if a >= x1:
                        break
                    overlap_x = min(x1, c) - a
                    overlap_y = min(y1, d) - max(y0, b)
                    assert overlap_x < 0.72 * min(
                        x1 - x0, c - a
                    ) or overlap_y < 0.72 * min(y1 - y0, d - b), (
                        i + 1,
                        "overlapping text glyphs",
                        (x0, y0, x1, y1),
                        (a, b, c, d),
                    )
            page.render(scale=1.1).to_pil().save(output / f"shop-page-{i + 1}.png")
            text.close()
            page.close()


def audit_artifacts(drawing, dxfs, pdf, bom, output):
    output.mkdir(exist_ok=True)
    parts = drawing["parts"]
    rows = list(csv.DictReader(io.StringIO(bom.decode("utf-8-sig"))))
    assert len(rows) == len(dxfs) == len(parts)
    for i, (part, data, row) in enumerate(zip(parts, dxfs, rows, strict=True), 1):
        units, kerf = drawing["units"], drawing.get("kerf_width", 0)
        net = audit_dxf(data, part, units, kerf)
        assert (
            row["Part ID"] == part["part_id"]
            and int(row["Quantity"]) == part["quantity"]
        )
        assert (
            row["Units"] == units
            and int(row["Pierces per piece"]) == len(part["holes"]) + 1
        )
        check_close(row["Thickness"], part["thickness"])
        density = part.get("density_kg_m3")
        if density is None:
            assert not row["Net mass per piece (kg)"] and not row["Net mass batch (kg)"]
        elif not kerf:
            mass = (
                net
                * part["thickness"]
                * (0.0254 if units == "in" else 0.001) ** 3
                * density
            )
            check_close(row["Net mass per piece (kg)"], mass, max(mass * 0.0005, 1e-8))
            check_close(
                row["Net mass batch (kg)"],
                mass * part["quantity"],
                max(mass * part["quantity"] * 0.0005, 1e-8),
            )
        (output / f"part-{i:03}.dxf").write_bytes(data)
    (output / "shop-drawing.pdf").write_bytes(pdf)
    (output / "bom.csv").write_bytes(bom)
    audit_shop_pdf(pdf, output)
    return f"{len(parts)} DXF(s), rendered PDF and reconciled BOM"


def audit_estimate(result):
    settings = result["settings"]
    for group in result["stock_groups"]:
        check_close(D(group["net_yield_pct"]) + D(group["scrap_pct"]), 100)
        assert 0 < D(group["net_yield_pct"]) <= D(group["blank_yield_pct"]) <= 100
    for line in result["lines"]:
        assert line["quantity"] > 0 and line["rows"]
        for row in line["rows"]:
            assert row["basis_text"] and row["citations"], (line["part_id"], row["id"])
        check_close(
            sum(D(row["cost_usd"]) for row in line["rows"]), line["estimated_cost_usd"]
        )
        for citation in [
            *(match["citation"] for match in line["history"]),
            *line["rules"],
        ]:
            assert citation["excerpt"] and citation["reference"]
        cut = next(
            row
            for row in line["baseline_rows"]
            if row["category"] == "cut" and row["stage"] == "run"
        )
        card, metrics = settings["cut"], line["metrics"]
        expected = (
            D(metrics["kerf_path_in"]) / D(card["speed_in_min"]) / 60
            + D(metrics["pierces"]) * D(card["seconds_per_pierce"]) / 3600
        ) / D(card["center"]["efficiency_factor"])
        check_close(cut["amount"], expected, 1e-6)
    cost = sum(D(line["estimated_cost_usd"]) for line in result["lines"])
    selling = sum(D(line["selling_price_usd"]) for line in result["lines"])
    check_close(result["estimated_cost_usd"], cost)
    check_close(result["selling_price_usd"], selling)
    check_close(selling, cost / (1 - D(result["gross_margin_pct"]) / 100), 0.005001)
    return f"{len(result['lines'])} priced line(s) recomputed in cents"


def compare_reference(source, result, reference):
    """Matched by part ID. A missing line is reported, never silently treated as equal."""
    if not reference.exists():
        return {"status": "not supplied"}
    actual = (
        {p["part_id"]: D(p["selling_price_usd"]) for p in result["lines"]}
        if result
        else {}
    )
    prior = json.loads(reference.read_text(encoding="utf-8-sig"))
    ref = {
        key: D(str(value)) for key, value in prior["selling_price_by_part_id"].items()
    }
    total = D(str(prior["selling_price_usd"]))
    current = D(result["selling_price_usd"]) if result else None

    def variance(now, then):
        return (
            str((100 * (now - then) / then).quantize(D(".01")))
            if now is not None and then
            else None
        )

    lines = []
    for key in sorted(actual.keys() | ref.keys()):
        now, then = actual.get(key), ref.get(key)
        rate = variance(now, then) if then is not None else None
        if (
            now is None
            or then is None
            or (then == 0 and now != 0)
            or (rate is not None and abs(D(rate)) > 10)
        ):
            lines.append(
                {
                    "part_id": key,
                    "estimate": str(now) if now is not None else None,
                    "reference": str(then) if then is not None else None,
                    "percent": rate,
                }
            )
    return {
        "source": source.name,
        "status": "compared" if result else "estimate held",
        "estimate": str(current) if current is not None else None,
        "reference": str(total),
        "percent": variance(current, total),
        "line_variances": lines,
    }


def compiled_control(output):
    from packages.cad.tests.test_sketch_pipeline import annotation, point, rectangle

    reading = rectangle()
    reading["title"] = "QA control - dimensions only"
    part = reading["parts"][0]
    part["annotations"][0] = annotation("width", '3-3/8"')
    part["annotations"][1] = annotation("height", '2 1/2"')
    part["annotations"][5] = annotation("quantity", "4")
    for i, (x, y) in enumerate(
        (("1/2", "1/2"), ("2 7/8", "1/2"), ("2 7/8", "2"), ("1/2", "2")), 1
    ):
        identifier = f"H{i}"
        part["holes"].append(
            {
                "shape": "round",
                "candidate": None,
                "confidence": 1,
                "at": point(300 + (i % 2) * 160, 300 + (i // 2) * 105),
            }
        )
        part["annotations"] += [
            annotation("x", x, identifier),
            annotation("y", y, identifier),
        ]
    part["annotations"].append(
        annotation("hole_callout", "4X Ø0.50 THRU", "H1", "H2", "H3", "H4")
    )
    part["annotations"].append(
        annotation("weld", '1/16" fillet, 1" length, 3" pitch', "E2")
    )
    assert measurement('1/16"', "in") == 0.0625
    solved = solve_sketch(reading, (1000, 1000))
    assert not solved.pins, [pin.message for pin in solved.pins]
    model = solved.drawing.model_dump(mode="json")
    model["parts"][0]["density_kg_m3"] = 7850
    assert model["parts"][0]["outline"]["width"] == 3.375
    assert all(hole["diameter"] == 0.5 for hole in model["parts"][0]["holes"])
    altered = deepcopy(reading)
    altered["parts"][0]["vertices"] = [
        point(11, 856),
        point(242, 892),
        point(250, 72),
        point(10, 79),
    ]
    assert solve_sketch(altered, (1000, 1000)).drawing == solved.drawing
    altered["parts"][0]["annotations"][0] = annotation("width", '3-1/2"')
    edited = solve_sketch(altered, (1000, 1000))
    assert edited.drawing.parts[0].outline.width == 3.5
    files = compile_drawing(model)
    result = audit_artifacts(
        model, files.dxfs, files.pdf, files.csv, output / "cad-control"
    )
    correction = compile_drawing(edited.drawing)
    audit_dxf(correction.dxfs[0], edited.drawing.parts[0].model_dump(mode="json"), "in")
    return result + "; edit 3.375 to 3.500 in; pixel aspect ratio made no change"


def browser_command(output, prior_run=None):
    args = [
        "exec",
        "node",
        "tests/real_drawing_browser.mjs",
        str(output.relative_to(ROOT)),
    ]
    if prior_run:
        args.append(str(prior_run))
    return (
        ["cmd.exe", "/d", "/c", "quote.cmd", *args]
        if os.name == "nt"
        else ["pnpm", *args]
    )


def run_case(api, case, receipt, target, references):
    filename = Path(case["path"])
    record = {"file": filename.name, "name": filename.name, "checks": {}}
    checks = record["checks"]

    def check(layer, call):
        try:
            checks[layer] = {"status": "PASS", "detail": call()}
        except Exception as exc:  # noqa: BLE001 - keep checking independent layers
            checks[layer] = {
                "status": "FAIL",
                "detail": str(exc) or type(exc).__name__,
                "traceback": traceback.format_exc(),
            }

    def read_record():
        assert "id" in receipt, receipt.get("error", "No browser upload receipt")
        ident = receipt["id"]
        result = api.call(
            ("/drawings/from-sketch/" if case["sketch"] else "/v1/blueprints/jobs/")
            + ident
        )
        record["state"] = result["state"]
        record["model"] = result.get("model") or (result.get("evidence") or {}).get(
            "model"
        )
        return result

    try:
        job = read_record()
    except Exception as exc:  # noqa: BLE001 - preserve other file outcomes
        return {
            **record,
            "checks": {"Upload/worker": {"status": "FAIL", "detail": str(exc)}},
        }
    write_json(target / "worker.json", job)
    drawing_id = job["drawing_id"] if case["sketch"] else job["drawing"]["id"]

    def source():
        blob = api.call(f"/v1/drawings/{drawing_id}/source")
        assert (
            hashlib.sha256(blob).hexdigest()
            == hashlib.sha256(filename.read_bytes()).hexdigest()
        )
        return "Original bytes round-tripped through versioned storage"

    def browser():
        assert receipt.get("ui"), receipt.get("error", "Browser check did not complete")
        return "Browser upload, polling, saved review and mobile viewport"

    def vision():
        assert record["model"] and job["state"] != "failed", (
            job["error"] or "Missing worker model"
        )
        assert job["needs_human_review"] == (
            job["state"] in {"review_required", "needs_review"}
        )
        if case["sketch"]:
            read = SketchMap.model_validate(job["reading"])
            pins = job["solution"]["pins"]
            low = any(
                part.confidence < 0.85
                or any(a.confidence < 0.85 for a in part.annotations)
                or any(h.confidence < 0.85 for h in part.holes + part.bends)
                for part in read.parts
            )
            if low or read.unit_confidence < 0.85:
                assert any(p["code"] == "low_confidence" for p in pins)
            if filename.name == "IMG_0684.jpeg":
                values = {
                    a.kind: measurement(a.value, "in")
                    for p in read.parts
                    if "mount" in p.name.lower()
                    for a in p.annotations
                    if a.kind in {"width", "height", "diameter"}
                }
                for part in read.parts:
                    if "mount" in part.name.lower():
                        for annotation in part.annotations:
                            if annotation.kind == "hole_callout":
                                _, values["diameter"] = hole_callout(annotation.value, "in")
                assert not any("Confirm the quantity and through-hole diameter" in pin["message"] for pin in pins)
                assert values == {"width": 10.0, "height": 2.5, "diameter": 0.875}, (
                    values
                )
                assert any("engineering" in p["message"].lower() for p in pins), (
                    "Plate size and hole diameter matched. The explicit engineering requirement "
                    "did not appear as a review flag."
                )
            if case.get("control"):
                assert job["state"] == "released"
                part = job["solution"]["drawing"]["parts"][0]
                assert (
                    part["outline"]["width"] == 120 and part["outline"]["height"] == 80
                )
                assert part["quantity"] == 3 and len(part["holes"]) == 1
                check_close(part["holes"][0]["length"], 36)
                check_close(part["holes"][0]["width"], 10)
            return f"{len(read.parts)} part readings, {len(pins)} review flags"
        ast = EngineeringAST.model_validate(job["ast"])
        flags = job["flags"]
        expected = [f.path for f in ast.review_flags() if f.kind == "low_confidence"]
        assert set(expected) <= {
            f["path"] for f in flags if f["kind"] == "low_confidence"
        }
        if filename.name == "2208_AWNING-A6.7.pdf":
            assert ast.source_release_hold and job["state"] == "review_required"
            assert not any(flag["path"] == "source_release_hold" for flag in flags)
            assert any(p.thickness_in == 0.3125 for p in ast.parts), (
                "Missed written 5/16-inch thickness"
            )
            assert any(
                "c3x6" in (p.section_designation or "").lower().replace(" ", "")
                for p in ast.parts
            ), "Missed C3x6 channel callout"
        return f"{len(ast.parts)} part readings, {len(flags)} review flags"

    def cad():
        if case["sketch"]:
            if job["state"] == "needs_review":
                assert job["solution"]["pins"] or job["solution"]["drawing"], (
                    "Empty review"
                )
                assert not job["files"], "A held drawing published shop files"
                api.call(
                    f"/drawings/from-sketch/{drawing_id}/files/{job['version']}/part-001.dxf",
                    status=409,
                )
                return "Release held for drawing review"
            assert job["state"] == "released", job.get("error")
            files = {f["name"]: api.call(f["href"]) for f in job["files"]}
            for meta in job["files"]:
                assert hashlib.sha256(files[meta["name"]]).hexdigest() == meta["sha256"]
            return audit_artifacts(
                job["solution"]["drawing"],
                [files[k] for k in sorted(files) if k.endswith(".dxf")],
                files["shop-drawing.pdf"],
                files["bom.csv"],
                target / "artifacts",
            )
        body = {"version": job["version"], "ast": job["ast"]}
        path = f"/v1/blueprints/jobs/{receipt['id']}"
        if job["state"] == "review_required":
            api.call(path + f"/shop-files/{job['version']}/0", status=409)
            if job["ast"]["source_release_hold"]:
                proof = api.call(path + "/proof", body)
                assert job["ast"]["source_release_hold"] not in proof["issues"]
            return "Release held for drawing review"
        assert job["state"] == "ready", job.get("error")
        proof = api.call(path + "/proof", body)
        assert proof["pdf"] and proof["dxfs"], proof.get("issues")
        model = blueprint_drawing(
            EngineeringAST.model_validate(job["ast"]),
            CostSettings.model_validate(job["settings"]),
            job["job_name"],
            job["version"],
        )
        model = model.model_copy(
            update={"title": ("REVIEW COPY | " + model.title)[:120]}
        )
        compiled = compile_drawing(model)
        pdf = base64.b64decode(proof["pdf"])
        # The API returns a DXF digest for review. Exact local recompilation verifies its bytes.
        assert [item["sha256"] for item in proof["dxfs"]] == [
            hashlib.sha256(blob).hexdigest() for blob in compiled.dxfs
        ]
        return audit_artifacts(
            model.model_dump(mode="json"),
            compiled.dxfs,
            pdf,
            compiled.csv,
            target / "artifacts",
        )

    def quote():
        if case["sketch"]:
            if job["state"] == "needs_review":
                return "Quote gated on confirmed sketch release"
            return (
                "Released sketch can supply a quote draft"
                if not case.get("control")
                else "Confirmed release opened a three-piece quote draft"
            )
        if job["state"] == "review_required":
            assert job["flags"] or job["error"], "No action shown for held estimate"
            assert not job["result"], "Held estimate published prices"
            return "Price held with review actions"
        return audit_estimate(job["result"])

    check("Browser", browser)
    check("Original", source)
    check("Vision/AST", vision)
    check("CAD", cad)
    check("Quote", quote)
    reference = references / (filename.name + ".quote.json")
    if reference.is_file():

        def check_reference():
            record["reference"] = compare_reference(
                filename, job.get("result"), reference
            )
            return record["reference"]["status"]

        check("Historical reference", check_reference)
    else:
        record["reference"] = {"status": "not supplied"}
    return record


def subprocess_logged(cmd, output):
    with output.open("w", encoding="utf-8") as stream:
        return subprocess.run(
            cmd, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=False
        ).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, default=ROOT / "tests/real_drawings")
    parser.add_argument(
        "--reuse-browser",
        type=Path,
        help="Recheck an existing isolated run without another vision request.",
    )
    args = parser.parse_args()
    api = AuditAPI()
    api.call("/health/ready")
    source = args.inputs.resolve()
    files = sorted(
        p for p in source.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED
    )
    unknown = sorted(
        p.name
        for p in source.iterdir()
        if p.is_file()
        and p.suffix.lower() not in SUPPORTED
        and p.name != "README.md"
        and not p.name.endswith(".quote.json")
    )
    if not files:
        parser.error("No PDF, DXF, JPEG, PNG, WebP or HEIC drawings found.")
    base = ROOT / ".test-results"
    base.mkdir(exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix="real-drawing-audit-", dir=base))
    cases = [{"path": str(p), "sketch": p.suffix.lower() in SKETCH} for p in files]
    cases.append(
        {
            "path": str(ROOT / "fixtures/sketches/slotted-mounting-plate.png"),
            "sketch": True,
            "control": True,
        }
    )
    write_json(output / "cases.json", cases)
    print(f"Audit output: {output}", flush=True)
    if args.reuse_browser:
        prior_run = args.reuse_browser.resolve()
        assert (
            json.loads((prior_run / "cases.json").read_text(encoding="utf-8-sig"))
            == cases
        )
    else:
        prior_run = None
    browser_status = subprocess_logged(
        browser_command(output, prior_run), output / "browser.log"
    )
    entries = []
    for index, case in enumerate(cases):
        target = output / f"drawing-{index + 1:03}"
        target.mkdir()
        receipt = output / f"browser-{index}.json"
        record = (
            json.loads(receipt.read_text(encoding="utf-8")) if receipt.exists() else {}
        )
        entry = run_case(api, case, record, target, source)
        check_scope = (
            not case["sketch"] and os.environ.get("LMM_REAL_SOURCE_SCOPE_AUDIT") == "1"
        )
        if not case.get("control") and (
            os.environ.get("LMM_REAL_ASSISTANT_AUDIT") == "1" or check_scope
        ):
            assistant = output / f"assistant-{index}.json"
            if assistant.is_file():
                entry["checks"].update(json.loads(assistant.read_text(encoding="utf-8")))
            else:
                entry["checks"]["Detailed review"] = {
                    "status": "FAIL", "detail": "The browser did not record the requested review checks."
                }
        if os.environ.get("LMM_REAL_INTAKE_GATE_AUDIT") == "1" and entry["file"] == "2208_AWNING-A6.7.pdf":
            gate_file = output / "ordinary-intake-hold.json"
            gate = json.loads(gate_file.read_text(encoding="utf-8")) if gate_file.is_file() else {}
            entry["checks"]["Regular quote intake permits review-stamped PDF"] = {
                "status": "PASS" if gate.get("proceeded") else "FAIL",
                "detail": gate or "The browser did not record an intake check.",
            }
        entries.append(entry)
    controls = {}
    for label, action in {
        "CAD and written dimensions": lambda: compiled_control(output),
        "Live quote hours override": lambda: (output / "quote-ui.json").read_text(
            encoding="utf-8"
        ),
        "PostgreSQL, pgvector, rules and Celery": lambda: integration(output),
        "Cost and extraction regression suite": lambda: regression(output),
    }.items():
        try:
            controls[label] = {"status": "PASS", "detail": action()}
        except Exception as exc:  # noqa: BLE001 - report every control result
            controls[label] = {
                "status": "FAIL",
                "detail": str(exc) or type(exc).__name__,
            }
    write_json(
        output / "report.json",
        {"drawings": entries, "controls": controls, "unrecognized_files": unknown},
    )
    print("| Drawing | Browser | Original | Vision/AST | CAD | Quote | Worker |")
    print("|---|---|---|---|---|---|---|")
    for row in entries:
        flags = [
            row["checks"].get(key, {}).get("status", "FAIL")
            for key in ("Browser", "Original", "Vision/AST", "CAD", "Quote")
        ]
        print(
            "| " + " | ".join([row["name"], *flags, row.get("state", "failed")]) + " |"
        )
        for check, details in row["checks"].items():
            print(f"  {check}: {details['detail']}")
        print(f"  Reference: {json.dumps(row.get('reference'), ensure_ascii=True)}")
    for key, value in controls.items():
        print(f"{value['status']} {key}: {value['detail']}")
    if unknown:
        print("Unsupported or unclassified inputs: " + ", ".join(unknown))
    return int(
        browser_status != 0
        or bool(unknown)
        or any(
            c["status"] == "FAIL" for entry in entries for c in entry["checks"].values()
        )
        or any(c["status"] == "FAIL" for c in controls.values())
    )


def integration(output):
    command = ["pwsh", "-NoProfile", "-File", "infra/setup.ps1", "verify", "-TestStack"]
    assert subprocess_logged(command, output / "database.log") == 0, "See database.log"
    return "Dated stock/rates, archive, immutable storage, cosine filters, history citations and rule approval"


def regression(output):
    command = [
        sys.executable,
        "-m",
        "pytest",
        "-q",
        "packages/cad/tests",
        "packages/ai/tests",
        "packages/costing/tests",
    ]
    assert subprocess_logged(command, output / "regression.log") == 0, (
        "See regression.log"
    )
    return (output / "regression.log").read_text(encoding="utf-8").splitlines()[-1]


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
