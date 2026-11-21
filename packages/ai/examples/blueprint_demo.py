"""Generate two synthetic, dimensioned PDF fixtures. Run as a module with an output directory."""

from __future__ import annotations

import argparse
from io import BytesIO, StringIO
from pathlib import Path

import ezdxf
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen.canvas import Canvas


def make_drawing(*, missing=False) -> bytes:
    buffer = BytesIO()
    pdf = Canvas(buffer, pagesize=letter, invariant=1)
    pdf.setTitle("Training drawing | fixture plate set")
    parts = [("FP-101", "Fixture plate", 6, 4, 4), ("FP-102", "Shim plate", 3, 2, 2)]
    for i, (code, label, width, height, qty) in enumerate(parts):
        pdf.setFont("Helvetica-Bold", 20)
        pdf.drawString(54, 714, f"{code}  |  {label}")
        pdf.setFont("Helvetica", 11)
        pdf.drawString(
            54, 685, f"Training drawing   /   Revision A   /   Sheet {i + 1} of 2"
        )
        pdf.rect(100, 390, width * 50, height * 50)
        pdf.drawCentredString(100 + width * 25, 373, f"{width:.2f} in")
        pdf.drawString(110 + width * 50, 390 + height * 25, f"{height:.2f} in")
        lines = [
            "Units: inches",
            "Flat rectangular blank, square corners (R0).",
            f"Blank dimensions: {width:.2f} in wide x {height:.2f} in high.",
            "Material: carbon steel, grade A36",
            "Thickness: 0.250 in",
            f"Order quantity: {qty} pieces",
        ]
        if missing and i == 1:
            lines = lines[:3] + [
                "Material and order quantity: awaiting customer confirmation."
            ]
        for k, line in enumerate(lines):
            pdf.drawString(54, 310 - 22 * k, line)
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


DXF_NOTES = (
    "M-1 fixture plate, revision B. Order quantity: 4 pieces. "
    "Material: carbon steel, grade A36, 6.35 mm thick. "
    "Flat rectangular blank, square corners. Profile is the closed outer cut on layer 0_CUT_OUTER."
)


def make_metric_dxf() -> bytes:
    doc = ezdxf.new("R2010", units=4)
    doc.layers.new("0_CUT_OUTER")
    doc.modelspace().add_lwpolyline(
        [(0, 0), (152.4, 0), (152.4, 101.6), (0, 101.6)],
        close=True,
        dxfattribs={"layer": "0_CUT_OUTER"},
    )
    stream = StringIO()
    doc.write(stream)
    return stream.getvalue().encode(doc.output_encoding)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    args.directory.mkdir(exist_ok=True, parents=True)
    for missing, name in [
        (False, "fixture-plate-set"),
        (True, "fixture-plate-set-missing"),
    ]:
        (args.directory / f"{name}.pdf").write_bytes(make_drawing(missing=missing))
