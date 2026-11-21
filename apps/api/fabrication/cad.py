"""Compile only reviewed, dimensioned input, keeping manufacturing math in Python."""
import io
import zipfile
from typing import Annotated, Literal
from fastapi import APIRouter, Header, Response
from packages.cad.schema import Drawing
from packages.cad.dxf_compiler import compile_drawing
from packages.cad.nesting import NestRequest, NestResult, plan_stock
from .desk import bounded

routes = APIRouter(prefix="/v1/cad", tags=["Engineering CAD"])


def zip_drawing(drawing: Drawing):
    artifacts = compile_drawing(drawing)
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for i, dxf in enumerate(artifacts.dxfs, start=1):
            bundle.writestr(f"part-{i:03}.dxf", dxf)
        bundle.writestr("shop-drawing.pdf", artifacts.pdf)
        bundle.writestr("bom.csv", artifacts.csv)
    return result.getvalue()


@routes.post("/compile", responses={200: {"content": {"application/zip": {}}}}, response_class=Response)
async def compile_reviewed(drawing: Drawing, reviewed: Annotated[Literal["confirmed"], Header(alias="X-Geometry-Review")]):
    """Require explicit confirmation by the calling review screen; return the complete artifact bundle."""
    archive = await bounded(zip_drawing, drawing)
    return Response(archive, media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="shop-drawing.zip"',
                             "Cache-Control": "no-store"})


@routes.post("/nest", response_model=NestResult)
async def nest_reviewed(request: NestRequest):
    return await bounded(plan_stock, request)

