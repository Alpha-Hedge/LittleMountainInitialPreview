import pytest
from pydantic import ValidationError

from packages.ai.validate import resolve_sketch_centers, validate_response


def test_request_specific_operation_and_source_contract():
    contract = {
        "type": "object", "required": ["op1"], "additionalProperties": False,
        "properties": {"op1": {"type": "object", "additionalProperties": False,
            "required": ["confidence", "sources"], "properties": {
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "sources": {"type": "array", "maxItems": 1, "items": {"type": "string", "enum": ["R1"]}}}}},
    }
    good = {"op1": {"confidence": 0.8, "sources": ["R1"]}}
    assert validate_response(contract, good) == good
    for value in ({"op2": good["op1"]}, {"op1": {"confidence": 1.01, "sources": []}},
                  {"op1": {"confidence": "0.8", "sources": []}},
                  {"op1": {"confidence": 0.7, "sources": ["R2"]}},
                  {"op1": {**good["op1"], "sellingPrice": 50}}):
        with pytest.raises(ValidationError):
            validate_response(contract, value)


def test_centered_token_uses_explicit_dimensions_only():
    part = {"name": "Plate", "outline": {"kind": "rectangle", "width": 121, "height": None},
            "holes": [{"centerX": "centered", "centerY": "centered"}, {"centerX": 2, "centerY": 3}]}
    review = resolve_sketch_centers({"draft": {"parts": [part]}, "questions": []})
    assert part["holes"] == [{"centerX": 60.5, "centerY": None}, {"centerX": 2, "centerY": 3}]
    assert len(review["questions"]) == 1
