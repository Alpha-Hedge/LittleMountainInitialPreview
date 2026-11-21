"""Compile the server-owned structured output contract into strict Pydantic ASTs.

The same contract is sent to the provider and checked here before use. Dynamic
part and operation keys bind each reply to its originating request.
"""
import json
import sys
from functools import reduce
from operator import or_
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError, create_model


class ExtractedNode(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def node(schema, name):
    if "anyOf" in schema:
        return reduce(or_, [node(option, name) for option in schema["anyOf"]])
    kind = schema["type"]
    if "enum" in schema:
        return Literal[tuple(schema["enum"])]
    if isinstance(kind, list):
        return reduce(or_, [node({**schema, "type": subtype}, name) for subtype in kind])
    if kind == "object":
        properties = schema["properties"]
        if schema.get("additionalProperties") is not False or set(schema["required"]) != set(properties):
            raise ValueError("Each extraction object needs an explicit closed schema.")
        fields = {key: (node(shape, name + "_" + key), ...) for key, shape in properties.items()}
        return create_model(name, __base__=ExtractedNode, **fields)
    if kind == "array":
        value_type = list[node(schema["items"], name + "_item")]
    else:
        value_type = {"integer": int, "number": float, "string": str,
                      "boolean": bool, "null": type(None)}[kind]
    constraints = {dest: schema[src] for src, dest in (
        ("minimum", "ge"), ("maximum", "le"), ("maxLength", "max_length"),
        ("minLength", "min_length"), ("maxItems", "max_length"), ("minItems", "min_length")
    ) if src in schema}
    return Annotated[value_type, Field(**constraints)] if constraints else value_type


def validate_response(schema, data):
    return TypeAdapter(node(schema, "FabricationAST")).validate_python(data, strict=True).model_dump(mode="json")


def resolve_sketch_centers(reading):
    """Only resolve the written 'centered' constraint for a rectangular blank."""
    for part in reading["draft"]["parts"]:
        for index, hole in enumerate(part["holes"], 1):
            for axis, size in (("centerX", "width"), ("centerY", "height")):
                if hole[axis] != "centered":
                    continue
                outline = part["outline"]
                span = outline[size] if outline["kind"] == "rectangle" else None
                if span is not None and span > 0:
                    hole[axis] = span / 2
                else:
                    hole[axis] = None
                    question = f"Confirm the {axis[-1]} center for opening {index} on {part['name']}."
                    if question not in reading["questions"] and len(reading["questions"]) < 60:
                        reading["questions"].append(question)
    return reading


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        data = validate_response(request["schema"], request["data"])
        if request.get("task") == "sketch":
            data = resolve_sketch_centers(data)
        print(json.dumps(data, allow_nan=False))
    except (ValueError, KeyError, TypeError, ValidationError):
        # Provider content and customer drawings stay out of diagnostic logs.
        print("The model response did not match the requested fields and evidence.", file=sys.stderr)
        sys.exit(2)
