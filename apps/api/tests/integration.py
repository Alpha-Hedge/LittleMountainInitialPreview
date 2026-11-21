"""Run inside the isolated Compose test API container with infra/setup.ps1 verify -TestStack."""
import copy
import io
import json
import os
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import UUID
import ezdxf


def request(path, method="GET", payload=None, media="application/json", auth=True, headers=None):
    data = (json.dumps(payload).encode() if payload is not None and not isinstance(payload, bytes) else payload)
    sent = {"Content-Type": media, **(headers or {})}
    if auth:
        sent["Authorization"] = "Bearer " + os.environ["NFIP_API_TOKEN"]
    try:
        res = urlopen(Request("http://127.0.0.1:8140" + path, data, sent, method=method), timeout=60)
    except HTTPError as exc:
        res = exc
    with res:
        body = res.read()
        if "application/json" in res.headers.get("Content-Type", ""):
            body = json.loads(body)
        return res.status, body


def expect(code, result):
    assert result[0] == code, (result[0], str(result[1])[:600])
    return result[1]


def test_storage():
    params = {"drawing_key": "test-sheet", "revision": 1, "filename": "bracket.dxf", "source_type": "NATIVE_DXF"}
    path = "/v1/drawings?" + urlencode(params)
    data = b"0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"

    def upload(content):
        return request(path, "POST", content, "application/dxf")

    status, first = upload(data)
    assert status in (200, 201), first
    again = expect(200, upload(data))
    assert first["id"] == again["id"] and first["source_version"] == again["source_version"]
    UUID(first["source_version"])
    expect(409, upload(data + b"CHANGED"))
    source = f"/v1/drawings/{first['id']}"
    assert expect(200, request(source + "/source")) == data
    task = expect(202, request(source + "/verify", "POST"))
    for _ in range(100):
        result = expect(200, request("/v1/jobs/" + task["job_id"]))
        if result["state"] in ("SUCCESS", "FAILURE"):
            break
        time.sleep(0.2)
    assert result["result"] == {"bytes": len(data), "matches": True, "source_version": first["source_version"]}, result
    return first["id"]


def test_rates():
    payload = {"name": "Test saw", "effective_on": "2020-01-01", "hourly_rate": "60.00", "unit": "USD/hour",
               "includes": "Operator and saw", "default_setup_minutes": "15", "efficiency_factor": "1"}
    for day, rate in (("2020-01-01","60.00"), ("2030-01-01","90.00")):
        code, detail = request("/v1/catalog/work-centers", "POST", {**payload, "effective_on": day, "hourly_rate": rate})
        assert code in (201,409), detail
    earlier = expect(200, request("/v1/catalog?as_of=2025-01-01"))["work_centers"]
    later = expect(200, request("/v1/catalog?as_of=2030-01-02"))["work_centers"]
    assert float(next(c for c in earlier if c["name"] == "Test saw")["hourly_rate"]) == 60
    assert float(next(c for c in later if c["name"] == "Test saw")["hourly_rate"]) == 90
    return next(c for c in earlier if c["name"] == "Test saw")["id"]


def test_snapshot(drawing_id, center_id):
    line = {"line_key": "part-1", "description": "Bracket", "quantity": 10, "work_center_id": center_id,
            "entered": {"cost_rows":[{"amount":1.5,"basis":"batch","rate":60}]}, "ai_proposed":{"hours":1},
            "nick_approved":{"hours":1.5}, "confidence_score": 0.82, "basis":"Similar prior job",
            "citations":[{"kind":"historical_job","reference":"examples/3","excerpt":"Batch setup 90 min"}],
            "override_reason":"Include fixture alignment"}
    payload = {"quote_number":"ENGINEERING-TEST", "revision":1, "customer_name":"Fixture Shop", "job_name":"Test bracket",
               "status":"approved", "gross_margin_pct":25, "pricing_inputs":{"estimatedCost":"200.00","sellingPrice":"266.67"},
               "drawing_id":drawing_id,"lines":[line]}
    def write():
        return request("/v1/quote-versions", "POST", payload)
    with ThreadPoolExecutor(max_workers=4) as pool:
        receipts = list(pool.map(lambda _: write(), range(4)))
    assert all(code in (200,201) for code, _ in receipts), receipts
    assert len({r["id"] for _,r in receipts}) == 1 and sum(c == 201 for c,_ in receipts) <= 1
    expect(409, request("/v1/quote-versions","POST",{**payload,"job_name":"overwrite"}))
    invalid = copy.deepcopy(payload)
    invalid["lines"][0]["confidence_score"] = 1.1
    expect(422, request("/v1/quote-versions","POST",invalid))
    invalid["lines"][0].update(confidence_score=None, ai_proposed=None, nick_approved=None)
    expect(422, request("/v1/quote-versions","POST",invalid))
    earlier = expect(200, request("/v1/quotes/ENGINEERING-TEST/versions/1"))
    assert earlier["lines"][0]["ai_proposed"] == line["ai_proposed"]
    assert earlier["lines"][0]["citations"] == line["citations"]
    assert earlier["lines"][0]["nick_approved"] == line["nick_approved"]
    assert float(earlier["lines"][0]["confidence_score"]) == 0.82
    newer = copy.deepcopy(payload)
    newer["revision"] = 2
    newer["lines"][0].update(ai_proposed=None, confidence_score=None, citations=[], nick_approved={"hours":2})
    assert request("/v1/quote-versions","POST",newer)[0] in (201,200)
    assert earlier == expect(200, request("/v1/quotes/ENGINEERING-TEST/versions/1"))
    return earlier["id"]


def test_cad():
    fixture = Path("/app/packages/cad/examples/slotted-bracket.json")
    drawing = json.loads(fixture.read_text())
    path = "/v1/cad/compile"
    confirmed = {"X-Geometry-Review":"confirmed"}
    expect(422, request(path, "POST", drawing))
    bundle = expect(200, request(path, "POST", drawing, headers=confirmed))
    with zipfile.ZipFile(io.BytesIO(bundle)) as z:
        assert z.read("shop-drawing.pdf").startswith(b"%PDF-")
        assert b"Pierces" in z.read("bom.csv")
        doc = ezdxf.read(io.StringIO(z.read("part-001.dxf").decode(), newline=None))
        audit = doc.audit()
        assert not audit.errors and not audit.fixes
        assert doc.units == (4 if drawing["units"] == "mm" else 1)
        assert all(e.closed for e in doc.modelspace().query('LWPOLYLINE'))
    conflict = copy.deepcopy(drawing)
    conflict["parts"][0]["holes"][0]["center"]["x"] = -1000
    expect(422, request(path, "POST", conflict, headers=confirmed))
    part = drawing["parts"][0]
    stock = {"drawing":drawing, "stock":[{"material":part["material"],"thickness":part["thickness"],"width":500,
                                          "height":500,"margin":5,"spacing":2,"allow_rotate":True}]}
    expect(200, request("/v1/cad/nest", "POST", stock))
    sketch = {"title":"Plate","units":"mm","parts":[{"name":"Plate","quantity":3,"material":"304 SS","thickness":6,
              "outline":{"kind":"rectangle","width":120,"height":80,"cornerRadius":0},"holes":[],"notes":""}]}
    preview = expect(200, request("/v1/desk/sketch","POST",{"draft":sketch,"format":"preview"}))
    assert preview["parts"][0]["bounds"] == [0,0,120,80]
    expect(422, request("/v1/desk/sketch","POST",{"draft":sketch,"format":"bundle"}))
    bundle = expect(200, request("/v1/desk/sketch","POST",{"draft":sketch,"format":"bundle","revision":1}))
    assert len(bundle["dxfs"]) == 1 and bundle["pdf"] and bundle["csv"]
    route = {"quantity":10,"stock":{"width":1000,"height":1000,"blankWidth":120,"blankHeight":80,"gap":3,
             "margin":5,"allowRotation":True,"sheetCost":80},"operations":[{"name":"Laser","unit":"mm cut",
             "unitsPerPiece":400,"unitsPerHour":20000,"setupMinutes":6,"hourlyRate":100}]}
    estimate = expect(200, request("/v1/desk/routing", "POST", route))
    assert estimate["total"] == 110 and estimate["operationHours"][0]["totalHours"] == 0.3


def main():
    expect(200, request("/health/ready",auth=False))
    expect(401, request("/v1/catalog",auth=False))
    drawing_id = test_storage()
    center_id = test_rates()
    quote_id = test_snapshot(drawing_id, center_id)
    test_cad()
    print(f"Verified worker checksum, immutable bytes, concurrent snapshots, audit values, dated rates, and CAD. Drawing {drawing_id}, quote {quote_id}")


if __name__ == "__main__":
    main()

