"""Exercise rule writes through the authenticated API on the isolated Compose stack."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from tests.integration import expect, request


def check():
    path = "/v1/catalog/nick-rules"
    key = "RAG-HTTP-" + uuid4().hex[:12]
    body = {"rule_key": key, "expected_revision": 0, "rule_category": "fixture",
            "condition_json": {"customer_name": key, "material_family": "6061", "processes": ["TIG"]},
            "adjustment": {"kind": "multiply_amount", "category": "weld", "stage": "setup", "factor": "1.2"},
            "rationale": "Allow for fixture alignment", "status": "approved", "approved_by": "Test reviewer"}
    expect(401, request(path, "POST", body, auth=False))
    expect(422, request(path, "POST", {**body, "adjustment": {"kind": "eval"}}))
    expect(422, request(path, "POST", {**body, "approved_by": None}))
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda _: request(path, "POST", body), range(4)))
    assert sorted(code for code, _ in responses) == [200, 200, 200, 201], responses
    assert len({r["id"] for _, r in responses}) == 1
    expect(409, request(path, "POST", {**body, "rationale": "different input, stale version"}))
    proposal = {**body, "expected_revision": 1, "approved_by": None, "status": "proposed"}
    assert expect(201, request(path, "POST", proposal))["revision"] == 2
    listed = next(row for row in expect(200, request(path)) if row["rule_key"] == key)
    assert listed["revision"] == 1 and listed["latest_revision"] == 2
    retire = {"expected_revision": 2, "retired_by": "Test reviewer", "reason": "End of test"}
    assert expect(201, request(f"{path}/{key}/retire", "POST", retire))["status"] == "retired"
    expect(200, request(f"{path}/{key}/retire", "POST", retire))
    history = expect(200, request(f"{path}/{key}/versions"))
    assert all(row["rule_key"] != key for row in expect(200, request(path)))
    assert [(r["revision"], r["status"]) for r in history] == [(3, "retired"), (2, "proposed"), (1, "approved")]
    print("Rule API passed authenticated writes, invalid adjustments, concurrent retries, stale edit, retirement and history.")


if __name__ == "__main__":
    check()
