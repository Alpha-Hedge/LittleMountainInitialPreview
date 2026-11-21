"""Compile a dimensioned, validated 2D drawing into DXFs, a shop PDF, and a BOM."""

from __future__ import annotations

import argparse
import csv
import io
from dataclasses import dataclass
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import ezdxf
from ezdxf.lldxf.tagwriter import TagWriter

from .geometry import Geometry, metrics, opening, outer_loop, solve_part
from .schema import Drawing
from .shop_sheet import make_pdf

OUTER, INNER, SCRIBE, REF = "0_CUT_OUTER", "1_CUT_INNER", "2_SCRIBE_ETCH", "3_REF_ONLY"
LAYERS = {OUTER: 7, INNER: 3, SCRIBE: 4, REF: 8}


def cut_loops(geom, kerf):
    if not kerf:
        return [(OUTER, geom.outer), *((INNER, h.loop) for h in geom.inner)]
    # Positive outside offset and negative opening offset move the cutter into waste.
    return [
        (OUTER, outer_loop(geom.part, kerf / 2)),
        *((INNER, opening(h, kerf / 2).loop) for h in geom.part.holes),
    ]


def make_dxf(drawing: Drawing, geom: Geometry):
    doc = ezdxf.new("R2010", units=1 if drawing.units == "in" else 4)
    doc.header["$MEASUREMENT"] = int(drawing.units == "mm")
    for name, aci in LAYERS.items():
        doc.layers.new(name, dxfattribs={"color": aci})
    space = doc.modelspace()
    loops = cut_loops(geom, drawing.kerf_width)
    for layer, vertices in loops:
        space.add_lwpolyline(vertices, format="xyb", close=True, dxfattribs={"layer": layer})
    for bend in geom.part.bends:
        space.add_line(bend.start.xy, bend.end.xy, dxfattribs={"layer": SCRIBE})
    xmin, ymin, xmax, ymax = geom.bounds
    offset = drawing.kerf_width / 2
    lower, upper = (xmin - offset, ymin - offset, 0), (xmax + offset, ymax + offset, 0)
    space.reset_extents(lower, upper)
    # ezdxf skips the header update when a bound is the zero vector.
    doc.header["$EXTMIN"], doc.header["$EXTMAX"] = lower, upper
    doc.set_modelspace_vport(
        height=max(ymax - ymin, xmax - xmin) * 1.15 + 2 * offset,
        center=((xmin + xmax) / 2, (ymin + ymax) / 2),
    )
    metadata = doc.ezdxf_metadata()
    path_mode = "KERF_COMPENSATED" if drawing.kerf_width else "NOMINAL"
    metadata["TOOLPATH_MODE"] = path_mode
    metadata["KERF_WIDTH"] = str(drawing.kerf_width)
    metadata["DIMENSION_UNIT"] = drawing.units
    doc.header["$USERR1"] = drawing.kerf_width
    # Keep release dates in the approval record. Give identical approved inputs repeatable
    # geometry artifacts, without changing ezdxf's process-global generation settings.
    doc.commit_pending_changes()
    doc.update_all()
    # ezdxf registers some classes by iterating an unordered type-name set.
    doc.classes.classes = dict(sorted(doc.classes.classes.items()))
    canonical = drawing.model_dump_json() + "/" + geom.part.part_id
    doc.header["$FINGERPRINTGUID"] = "{" + str(uuid5(NAMESPACE_URL, canonical)).upper() + "}"
    doc.header["$VERSIONGUID"] = doc.header["$FINGERPRINTGUID"]
    for stamp in ("$TDCREATE", "$TDUCREATE", "$TDUPDATE", "$TDUUPDATE"):
        doc.header[stamp] = 2451544.5  # Fixed build epoch (2000-01-01 UTC).
    metadata["CREATED_BY_EZDXF"] = metadata["WRITTEN_BY_EZDXF"] = f"ezdxf {ezdxf.__version__}"
    output = io.StringIO()
    doc.export_sections(TagWriter(output, dxfversion=doc.dxfversion, write_handles=True))
    data = doc.encode(output.getvalue()).replace(b"\n", b"\r\n")
    # Audit precisely what will be issued, including the header and layer assignments.
    received = ezdxf.read(io.TextIOWrapper(io.BytesIO(data), encoding="utf-8", newline=None))
    audit = received.audit()
    if audit.errors or audit.fixes:
        raise ValueError("DXF readback failed its ezdxf audit.")
    entities = list(received.modelspace())
    if (
        received.units != (1 if drawing.units == "in" else 4)
        or tuple(received.header["$EXTMIN"]) != lower
        or tuple(received.header["$EXTMAX"]) != upper
        or received.ezdxf_metadata()["TOOLPATH_MODE"] != path_mode
        or received.header["$USERR1"] != drawing.kerf_width
        or not all(name in received.layers for name in LAYERS)
        or len(entities) != len(loops) + len(geom.part.bends)
    ):
        raise ValueError("DXF readback changed units, layers, or entity count.")
    for entity, (layer, vertices) in zip(entities[: len(loops)], loops, strict=True):
        if (
            entity.dxftype() != "LWPOLYLINE"
            or not entity.closed
            or entity.dxf.layer != layer
            or list(entity.get_points("xyb")) != vertices
        ):
            raise ValueError("DXF cut loop failed geometry or closure verification.")
    for entity, bend in zip(entities[len(loops) :], geom.part.bends, strict=True):
        if (
            entity.dxftype() != "LINE"
            or entity.dxf.layer != SCRIBE
            or tuple(entity.dxf.start) != (*bend.start.xy, 0)
            or tuple(entity.dxf.end) != (*bend.end.xy, 0)
        ):
            raise ValueError("DXF scribe line failed coordinate verification.")
    return data


def spreadsheet_text(s):
    return (
        "'" + s
        if s.lstrip("\ufeff \n\r\t").startswith(("=", "+", "-", "@"))
        or s.startswith(("\t", "\r", "\n"))
        else s
    )


def display_number(n):
    return int(n) if n == int(n) else float(f"{n:.12g}")


def make_csv(drawing, geometries):
    output = io.StringIO(newline="")
    writer = csv.writer(output, quoting=csv.QUOTE_NONNUMERIC)
    writer.writerow(
        [
            "Part number",
            "Part",
            "Quantity",
            "Material",
            "Thickness",
            "Units",
            "Blank width",
            "Blank height",
            "Notes",
            "Part ID",
            "Revision",
            "Net area per piece (units^2)",
            "Nominal cut length per piece (units)",
            "Pierces per piece",
            "Bends per piece",
            "Density (kg/m^3)",
            "Net mass per piece (kg)",
            "Net mass batch (kg)",
            "DXF kerf width (units)",
            "DXF cut path per piece (units)",
        ]
    )
    for i, g in enumerate(geometries, 1):
        p = g.part
        x0, y0, x1, y1 = g.bounds
        mass = None
        if p.density_kg_m3 is not None:
            metres = 0.0254 if drawing.units == "in" else 0.001
            mass = g.net_area * p.thickness * metres**3 * p.density_kg_m3
        path_length = sum(metrics(loop)[1] for _, loop in cut_loops(g, drawing.kerf_width))
        row = [
            i,
            p.name,
            p.quantity,
            p.material,
            p.thickness,
            drawing.units,
            x1 - x0,
            y1 - y0,
            p.notes,
            p.part_id,
            drawing.revision,
            g.net_area,
            g.cut_length,
            1 + len(g.inner),
            len(p.bends),
            p.density_kg_m3,
            mass,
            mass * p.quantity if mass is not None else None,
            drawing.kerf_width,
            path_length,
        ]
        writer.writerow(
            [
                spreadsheet_text(v)
                if isinstance(v, str)
                else display_number(v)
                if isinstance(v, float)
                else v
                for v in row
            ]
        )
    return output.getvalue().encode("utf-8")


@dataclass(frozen=True)
class Artifacts:
    dxfs: list[bytes]
    pdf: bytes
    csv: bytes
    part_pages: list[int]


def compile_drawing(drawing: Drawing | dict) -> Artifacts:
    drawing = Drawing.model_validate(drawing)
    geometries = [solve_part(p) for p in drawing.parts]
    dxfs = [make_dxf(drawing, g) for g in geometries]
    pdf, starts = make_pdf(drawing, geometries)
    return Artifacts(dxfs, pdf, make_csv(drawing, geometries), starts)


def compile_solved_sketch(solution) -> Artifacts:
    """Release exactly the nominal geometry checked by the photo constraint solver."""
    if solution.pins or solution.drawing is None:
        raise ValueError("Resolve the drawing pins before exporting cut files.")
    return compile_drawing(solution.drawing)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("drawing", type=Path, help="Reviewed drawing AST JSON file")
    parser.add_argument("output", type=Path, help="New directory for the validated artifacts")
    args = parser.parse_args()
    drawing = Drawing.model_validate_json(args.drawing.read_bytes())
    artifacts = compile_drawing(drawing)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # No partial release and no overwriting an existing job or revision.
    from tempfile import TemporaryDirectory

    with TemporaryDirectory(dir=args.output.parent) as stage:
        release = Path(stage) / "release"
        release.mkdir()
        for i, data in enumerate(artifacts.dxfs, 1):
            (release / f"part-{i:03}.dxf").write_bytes(data)
        (release / "shop-drawing.pdf").write_bytes(artifacts.pdf)
        (release / "bom.csv").write_bytes(artifacts.csv)
        if args.output.exists():
            parser.error("Choose a new output directory for this release.")
        release.rename(args.output)


if __name__ == "__main__":
    main()
