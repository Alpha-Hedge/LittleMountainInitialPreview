"""Keep these adapters identical to the workstation's Python execution contracts."""
import asyncio
import json
from decimal import DecimalException
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, model_validator
from starlette.concurrency import run_in_threadpool

from packages.cad.bridge import process as sketch
from packages.costing.routing import Routing, estimate

routes = APIRouter(prefix="/v1/desk", tags=["Engineering desktop"])
capacity = asyncio.BoundedSemaphore(2)


async def bounded(fn, payload):
    async with capacity:
        try:
            return await run_in_threadpool(fn, payload)
        except ValidationError as exc:
            detail = exc.errors(include_input=False, include_url=False)[0]
            where = ".".join(map(str, detail["loc"]))
            raise HTTPException(422, f"{where}: {detail['msg']}") from exc
        except (ValueError, KeyError, TypeError, DecimalException) as exc:
            raise HTTPException(422, str(exc)[:500]) from exc


class DeskSketch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    draft: dict[str, JsonValue]
    format: Literal["preview","validate","bundle","pdf","csv","dxf"]
    revision: int | None = Field(default=None, gt=0)
    part: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def check_release(self):
        if self.format not in {"preview","validate"} and self.revision is None:
            raise ValueError("Confirm a drawing revision before generating manufacturing files.")
        return self


@routes.post("/routing")
async def desk_routing(inputs: Routing):
    return await bounded(estimate, inputs)


@routes.post("/sketch")
async def desk_sketch(inputs: DeskSketch):
    payload = inputs.model_dump(exclude_none=True)
    if len(json.dumps(payload,separators=(",", ":"),ensure_ascii=False).encode()) > 2_000_000:
        raise HTTPException(413, "Drawing exceeds the compiler input limit.")
    return await bounded(sketch, payload)

