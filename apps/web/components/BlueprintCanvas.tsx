"use client";

import Activity from "@/components/Activity";
import { useEffect, useRef, useState } from "react";
import type { Point } from "@/lib/sketch/types";
import type {
  PhotoReading,
  SketchConversion,
} from "@/lib/sketch/conversion-types";
import type {
  BlueprintJob,
  BlueprintObject,
  BlueprintValue,
} from "@/lib/blueprint-types";
import "./review-workspace.css";

type XY = [number, number];
type Shape = {
  id: string;
  controls: XY[];
  bounds: [number, number, number, number];
  paths: { kind: string; points: XY[] }[];
};
type Proof = {
  geometry: Shape[];
  issues: string[];
  pdf: string | null;
  dxfs: { part: string; sha256: string; size: number }[];
};
type Field = {
  id: string;
  part: string;
  name: string;
  value: string;
  score: number;
  at?: Point;
  cad?: XY;
  page: number;
  source: string;
  choices?: string[];
  apply: (v: string) => void;
  place?: (p: Point) => void;
};
type Anchor = { model: XY[]; page: Point[] };
type CanvasProps = {
  src: string;
  endpoint: string;
  payload: object;
  marks: Field[];
  anchors: Record<string, Anchor>;
  locked: boolean;
  page: number;
  onAlign?: (name: string, points: Point[], bounds: number[]) => void;
  parts: string[];
  fallback?: { id: string; points: Point[] }[];
};
const xy = (p: Point): XY => [p.x, p.y];
const pt = (a: XY): Point => ({ x: a[0], y: a[1] });
const object = (v: BlueprintValue | undefined): BlueprintObject =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const list = (v: BlueprintValue | undefined) =>
  Array.isArray(v) ? v.map(object) : [];
const title = (s: string) =>
  s
    .replaceAll("_in2", " (in²)")
    .replaceAll("_in", " (in)")
    .replaceAll("_deg", " (°)")
    .replaceAll("_", " ");
function percent(score: number) {
  const rounded = Number((score * 100).toFixed(2));
  return score < 0.85 ? Math.min(84.99, rounded) : rounded;
}
function project(anchors: Anchor | undefined) {
  if (!anchors || anchors.model.length < 3) return;
  const from = anchors.model,
    to = anchors.page;
  const [x, y] = from[0];
  for (let i = 1; i < from.length - 1; i++)
    for (let j = i + 1; j < from.length; j++) {
      if (!to[0] || !to[i] || !to[j]) continue;
      const u = from[i][0] - x,
        v = from[i][1] - y,
        s = from[j][0] - x,
        t = from[j][1] - y,
        det = u * t - v * s;
      if (Math.abs(det) < 1e-8) continue;
      return ([a, b]: XY): Point => {
        const first = ((a - x) * t - (b - y) * s) / det,
          second = (u * (b - y) - v * (a - x)) / det;
        return {
          x:
            to[0].x +
            first * (to[i].x - to[0].x) +
            second * (to[j].x - to[0].x),
          y:
            to[0].y +
            first * (to[i].y - to[0].y) +
            second * (to[j].y - to[0].y),
        };
      };
    }
}
function PinInput({ field, locked }: { field: Field; locked: boolean }) {
  const [raw, setRaw] = useState(field.value);
  const sent = useRef(field.value);
  useEffect(() => {
    if (field.value !== sent.current) setRaw(field.value);
  }, [field.value]);
  return (
    <input
      aria-label="Drawing value"
      disabled={locked}
      value={raw}
      onChange={(e) => {
        const v = e.target.value;
        setRaw(v);
        sent.current =
          v.trim() !== "" && Number.isFinite(Number(v)) ? String(Number(v)) : v;
        field.apply(v);
      }}
    />
  );
}
function ProofPdf({ data }: { data: string }) {
  const [link, setLink] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
        type: "application/pdf",
      }),
    );
    setLink(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);
  return (
    link && (
      <a href={link} target="_blank" rel="noreferrer">
        Open recompiled shop PDF
      </a>
    )
  );
}
export default function BlueprintCanvas({
  src,
  endpoint,
  payload,
  marks,
  anchors,
  locked,
  page,
  onAlign,
  parts,
  fallback,
}: CanvasProps) {
  const body = JSON.stringify(payload),
    requestKey = endpoint + body;
  const [result, setResult] = useState<{
    key: string;
    proof?: Proof;
    error?: string;
  } | null>(null);
  const [selected, select] = useState(""),
    [overlay, show] = useState(true),
    [ratio, aspect] = useState(1.35);
  const [align, setAlign] = useState<{ part: string; points: Point[] } | null>(
      null,
    ),
    [placing, place] = useState("");
  const [part, choosePart] = useState(parts[0] || "");
  const svg = useRef<SVGSVGElement>(null);
  const saved = useRef<{ endpoint: string; controls: Record<string, XY[]> }>({
    endpoint: "",
    controls: {},
  });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });
        const data = await r.json();
        if (!r.ok)
          throw Error(
            typeof data.detail === "string"
              ? data.detail
              : data.error || "Check the entered values.",
          );
        if (!controller.signal.aborted) {
          if (saved.current.endpoint !== endpoint)
            saved.current = { endpoint, controls: {} };
          for (const s of (data as Proof).geometry)
            saved.current.controls[s.id] ??= s.controls;
          setResult({ key: requestKey, proof: data });
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setResult({
            key: requestKey,
            error: e instanceof Error ? e.message : "Unable to compile.",
          });
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, body, requestKey]);
  const proof = result?.key === requestKey ? result.proof : undefined;
  const error = result?.key === requestKey ? result.error : "";
  const transforms = Object.fromEntries(
    Object.entries(anchors).map(([id, a]) => [
      id,
      project({
        ...a,
        model: a.model.length ? a.model : saved.current.controls[id] || [],
      }),
    ]),
  );
  const current = marks.find((m) => m.id === selected);
  const visible = marks.filter((m) => m.page === page);
  const location = (f: Field) => f.at || (f.cad && transforms[f.part]?.(f.cad));
  const here = current && location(current);
  const nearby = here
    ? visible.filter((f) => {
        const at = location(f);
        return (
          at &&
          f.id !== current?.id &&
          Math.hypot(at.x - here.x, at.y - here.y) < 22
        );
      })
    : [];
  function pointEvent(e: React.MouseEvent<SVGSVGElement>) {
    const m = svg.current?.getScreenCTM();
    if (!m) return;
    const a = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const p = {
      x: Math.round(Math.max(0, Math.min(1000, a.x))),
      y: Math.round(Math.max(0, Math.min(1000, a.y))),
    };
    if (placing) {
      marks.find((f) => f.id === placing)?.place?.(p);
      place("");
    } else if (align) {
      const points = [...align.points, p];
      if (points.length < 3) setAlign({ ...align, points });
      else {
        const bounds = proof?.geometry.find((s) => s.id === align.part)?.bounds;
        if (bounds) onAlign?.(align.part, points, bounds);
        setAlign(null);
      }
    }
  }
  function choose(id: string) {
    select(id);
    setAlign(null);
    place("");
  }
  return (
    <section className="bw-canvas" aria-label="Interactive drawing review">
      <div className="bw-heading">
        <h3>Drawing measurements</h3>
        <label className="bw-inline">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(e) => show(e.target.checked)}
          />
          Show overlay
        </label>
      </div>
      <div className="bw-legend">
        <span>
          <i className="bw-dot high" />
          85% or higher
        </span>
        <span>
          <i className="bw-dot low" />
          Below 85% · check reading
        </span>
      </div>
      {onAlign && !locked && (
        <div className="bw-align">
          {parts.length > 1 && (
            <label>
              Part{" "}
              <select value={part} onChange={(e) => choosePart(e.target.value)}>
                {parts.map((i) => (
                  <option key={i}>{i}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            disabled={!proof?.geometry.some((s) => s.id === part)}
            onClick={() => {
              setAlign({ part, points: [] });
              place("");
            }}
          >
            Align outline to page
          </button>
        </div>
      )}
      {(align || placing) && (
        <p role="status">
          {placing
            ? "Click the callout on this page."
            : "Click the " +
              ["lower-left", "lower-right", "upper-left"][
                align!.points.length
              ] +
              " corner of the part’s bounding box."}{" "}
          <button
            type="button"
            onClick={() => {
              setAlign(null);
              place("");
            }}
          >
            Cancel placement
          </button>
        </p>
      )}
      <div className="bw-paper" style={{ aspectRatio: String(ratio) }}>
        <img
          src={src}
          alt={"Source drawing, page " + page}
          onLoad={(e) =>
            aspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)
          }
        />
        <svg
          ref={svg}
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          aria-label="Reconstructed geometry and numbered callouts"
          onClick={pointEvent}
        >
          {overlay &&
            fallback
              ?.filter((s) => !proof?.geometry.some((g) => g.id === s.id))
              .map((s) => (
                <polygon
                  key={s.id}
                  className="bw-hint"
                  points={s.points.map((p) => xy(p).join(",")).join(" ")}
                />
              ))}
          {overlay &&
            proof?.geometry.flatMap((s) => {
              const map = transforms[s.id];
              return map
                ? s.paths.map((p, i) => {
                    const pts = p.points
                      .map((v) => xy(map(v)).join(","))
                      .join(" ");
                    return p.kind === "bend" ? (
                      <polyline
                        key={s.id + i}
                        className="bw-bend"
                        points={pts}
                      />
                    ) : (
                      <polygon
                        key={s.id + i}
                        className="bw-outline"
                        points={pts}
                      />
                    );
                  })
                : [];
            })}
          {align?.points.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={8} fill="#075b9d" />
          ))}
          {overlay &&
            visible.map((f, i) => {
              const p = f.at || (f.cad && transforms[f.part]?.(f.cad));
              return (
                p && (
                  <g
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      f.name + ", " + percent(f.score) + "% confidence"
                    }
                    className={"bw-pin " + (f.score >= 0.85 ? "high" : "low")}
                    onClick={(e) => {
                      if (align || placing) return;
                      e.stopPropagation();
                      choose(f.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        choose(f.id);
                      }
                    }}
                  >
                    <title>{f.name + " · " + f.value}</title>
                    <circle cx={p.x} cy={p.y} r={selected === f.id ? 20 : 16} />
                    <text x={p.x} y={p.y} dy=".36em">
                      {i + 1}
                    </text>
                  </g>
                )
              );
            })}
        </svg>
      </div>
      {onAlign &&
        proof?.geometry.some(
          (s) => parts.includes(s.id) && !transforms[s.id],
        ) && (
          <p>Align the outline to place reconstructed edges over this view.</p>
        )}
      <label className="field">
        Measurement or weld callout
        <select value={selected} onChange={(e) => choose(e.target.value)}>
          <option value="">Choose a numbered reading</option>
          {visible.map((f, i) => (
            <option key={f.id} value={f.id}>
              {i + 1}. {f.part} · {f.name} · {f.value || "Missing"} (
              {percent(f.score)}%)
            </option>
          ))}
        </select>
      </label>
      {current && current.page === page && (
        <div className="bw-pin-editor">
          <strong>
            {current.part} · {current.name}
          </strong>
          <label className="field">
            Drawing value
            {current.choices ? (
              <select
                value={current.value}
                disabled={locked}
                onChange={(e) => current.apply(e.target.value)}
              >
                <option value="">Choose value</option>
                {current.choices.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ) : (
              <PinInput key={current.id} field={current} locked={locked} />
            )}
          </label>
          <small>
            {percent(current.score)}% confidence ·{" "}
            {current.source || "Source reading"}
          </small>
          {nearby.length > 0 && (
            <details>
              <summary>Other readings at this point</summary>
              {nearby.map((f) => (
                <button type="button" key={f.id} onClick={() => choose(f.id)}>
                  {f.name} · {f.value || "Missing"}
                </button>
              ))}
            </details>
          )}
          {current.place && !locked && (
            <button
              type="button"
              onClick={() => {
                place(current.id);
                setAlign(null);
              }}
            >
              Place callout on page
            </button>
          )}
        </div>
      )}
      <div className="bw-proof" aria-live="polite">
        {error ||
          (!proof
            ? <Activity>Checking the drawing</Activity>
            : proof.pdf
              ? "DXF and shop PDF recompiled"
              : "Resolve the drawing details to compile the files.")}{" "}
        {proof?.pdf && <ProofPdf data={proof.pdf} />}
      </div>
      {!!proof?.issues.length && (
        <details>
          <summary>{proof.issues.length} drawing checks</summary>
          <ul>
            {proof.issues.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
export function PhotoCanvas({
  record,
  reading,
  verified,
  onChange,
  locked,
}: {
  record: SketchConversion;
  reading: PhotoReading;
  verified: string[];
  onChange: (r: PhotoReading) => void;
  locked: boolean;
}) {
  const base = "/api/sketch-conversions/" + record.drawing_id;
  const marks: Field[] = reading.parts.flatMap((p, i) =>
    p.annotations.map((m, j) => ({
      id: i + "." + j,
      part: p.part_id,
      name: title(m.kind) + " · " + m.targets.join(", "),
      value: m.value,
      score: m.confidence,
      at: m.at,
      page: 1,
      source: m.evidence,
      apply: (v: string) => {
        const next = structuredClone(reading);
        next.parts[i].annotations[j] = {
          ...m,
          value: v,
          evidence: "Staff entered " + v,
          confidence: 1,
        };
        onChange(next);
      },
    })),
  );
  const anchors: Record<string, Anchor> = {};
  reading.parts.forEach((p, i) => {
    const o = record.solution?.drawing?.parts[i]?.outline;
    const model: XY[] =
      o?.kind === "rectangle"
        ? [
            [0, 0],
            [o.width, 0],
            [o.width, o.height],
            [0, o.height],
          ]
        : o?.kind === "polygon"
          ? o.vertices.map(xy)
          : [];
    anchors[p.part_id] = {
      model,
      page: record.reading?.parts[i]?.vertices || p.vertices,
    };
  });
  return (
    <BlueprintCanvas
      src={base + "/preview/page"}
      endpoint={base + "/proof"}
      payload={{ version: record.version, reading, verified }}
      marks={marks}
      anchors={anchors}
      locked={locked}
      page={1}
      parts={reading.parts.map((p) => p.part_id)}
      fallback={reading.parts.map((p) => ({
        id: p.part_id,
        points: p.vertices,
      }))}
    />
  );
}

type Edit = (path: string[], value: BlueprintValue) => void;
const enums: Record<string, string[]> = {
  process: ["GMAW", "GTAW", "FCAW", "SMAW"],
  joint_type: ["fillet", "groove", "plug", "slot", "other"],
  joint_configuration: ["butt", "tee", "lap", "corner", "edge", "other"],
  position: ["1F", "2F", "3F", "4F", "1G", "2G", "3G", "4G", "5G", "6G"],
};
export function EngineeringCanvas({
  job,
  ast,
  settings = job.settings,
  onChange,
  locked = false,
}: {
  job: BlueprintJob;
  ast: BlueprintObject;
  settings?: BlueprintObject;
  onChange: Edit;
  locked?: boolean;
}) {
  const [page, setPage] = useState(1),
    [pageCount, setPageCount] = useState(1);
  const src =
    "/api/blueprints/drawings/" + job.drawing.id + "/preview?page=" + page;
  const [preview, setPreview] = useState<{
    src: string;
    url: string;
    frames: number[][];
  } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    const c = new AbortController();
    let url = "";
    setFailure("");
    fetch(src, { signal: c.signal })
      .then(async (r) => {
        if (!r.ok) throw Error("Drawing preview unavailable.");
        const frames = JSON.parse(r.headers.get("x-profile-frames") || "[]"),
          pages = Number(r.headers.get("x-page-count")) || 1,
          blob = await r.blob();
        if (!c.signal.aborted) {
          url = URL.createObjectURL(blob);
          setPreview({ src, url, frames });
          setPageCount(pages);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setFailure(e.message);
      });
    return () => {
      c.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);
  const anchors: Record<string, Anchor> = {},
    marks: Field[] = [];
  const parts = list(ast.parts);
  const initial = list(job.ast?.parts);
  const pageParts: string[] = [];
  parts.forEach((p, i) => {
    const id = String(p.part_id),
      outline = object(p.outline),
      original = object(initial[i]?.outline),
      frame = object(p.page_frame);
    if (Number(object(frame.lower_left).page) === page) {
      const points = [frame.lower_left, frame.lower_right, frame.upper_left]
        .map((v) => object(v))
        .map((v) => ({ x: Number(v.x), y: Number(v.y) }));
      const verts = list(original.vertices);
      const bounds = Array.isArray(frame.cad_bounds_in)
        ? frame.cad_bounds_in.map(Number)
        : verts.length
          ? [
              Math.min(...verts.map((v) => Number(v.x))),
              Math.min(...verts.map((v) => Number(v.y))),
              Math.max(...verts.map((v) => Number(v.x))),
              Math.max(...verts.map((v) => Number(v.y))),
            ]
          : [0, 0, Number(original.width_in), Number(original.height_in)];
      anchors[id] = {
        page: points,
        model: [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[1]],
          [bounds[0], bounds[3]],
        ],
      };
    }
    const sourcePage = Number(
      list(outline.evidence).find((e) => e.page)?.page ||
        list(p.evidence).find((e) => e.page)?.page ||
        1,
    );
    if (Number(object(frame.lower_left).page || sourcePage) === page)
      pageParts.push(id);
    if (
      !anchors[id] &&
      !frame.lower_left &&
      sourcePage === page &&
      preview?.src === src &&
      original.kind === "rectangle"
    ) {
      const width = Number(original.width_in),
        height = Number(original.height_in),
        ratio = width / height;
      const samePage = initial.filter(
        (other) =>
          Number(
            list(object(other.outline).evidence).find((e) => e.page)?.page ||
              list(other.evidence).find((e) => e.page)?.page ||
              1,
          ) === page,
      );
      const candidates = preview.frames.filter(
        (f) => Math.abs(f[4] / ratio - 1) < 0.06,
      );
      if (samePage.length === 1 && candidates.length === 1) {
        const [left, top, right, bottom] = candidates[0];
        anchors[id] = {
          model: [
            [0, 0],
            [width, 0],
            [0, height],
          ],
          page: [
            { x: left, y: bottom },
            { x: right, y: bottom },
            { x: left, y: top },
          ],
        };
      }
    }
    function fields(
      node: BlueprintObject,
      base: string[],
      label: string,
      keys: string[],
      cad?: XY,
      owner = node,
      ownerPath = base,
    ) {
      const evidence = list(owner.evidence),
        locations = list(owner.field_locations);
      for (const key of keys) {
        const fieldKey = [...base.slice(ownerPath.length), key].join(".");
        const anchor = object(
          locations.find((l) => l.field === fieldKey)?.location ||
            owner.page_anchor,
        );
        const citation =
          evidence.find(
            (e) => Array.isArray(e.fields) && e.fields.includes(key),
          ) || evidence[0];
        const value = node[key],
          numeric = !enums[key],
          path = [...base, key],
          where = Number(
            anchor.page ||
              citation?.page ||
              object(frame.lower_left).page ||
              sourcePage,
          );
        marks.push({
          part: id,
          id: path.join("."),
          name: label + " " + title(key),
          value: value == null ? "" : String(value),
          score: Number(owner.confidence ?? 0),
          page: where,
          source: String(citation?.excerpt || ""),
          choices: enums[key],
          cad,
          at:
            anchor.x != null
              ? { x: Number(anchor.x), y: Number(anchor.y) }
              : undefined,
          apply: (v) =>
            onChange(
              path,
              v === ""
                ? null
                : numeric
                  ? Number.isFinite(Number(v))
                    ? Number(v)
                    : v
                  : v,
            ),
          place: (pt) =>
            onChange(
              [...ownerPath, "field_locations"],
              [
                ...locations.filter((l) => l.field !== fieldKey),
                { field: fieldKey, location: { page, ...pt } },
              ],
            ),
        });
      }
    }
    const base = ["parts", String(i)],
      x = Number(outline.width_in || 0),
      y = Number(outline.height_in || 0);
    fields(p, base, "Part", ["thickness_in", "quantity"], [0, 0]);
    for (const [key, located] of [
      ["width_in", [x / 2, y]],
      ["height_in", [x, y / 2]],
      ["corner_radius_in", [x, y]],
    ] as [string, XY][])
      if (outline.kind === "rectangle" || outline[key] != null)
        fields(outline, [...base, "outline"], "Outline", [key], located);
    list(outline.vertices).forEach((v, n) =>
      fields(
        v,
        [...base, "outline", "vertices", String(n)],
        "Vertex " + (n + 1),
        ["x", "y"],
        [Number(v.x), Number(v.y)],
        outline,
        [...base, "outline"],
      ),
    );
    for (const group of ["holes", "bends", "welds"])
      list(p[group]).forEach((v, n) => {
        if(group==="bends") for(const key of ["start_in","end_in"]){
          const end=object(v[key]);
          if(end.x!=null && end.y!=null) fields(end,[...base,group,String(n),key],"Bend "+(n+1)+" "+(key==="start_in"?"start":"end"),["x","y"],[Number(end.x),Number(end.y)],v,[...base,group,String(n)]);
        }
        const keys =
          group === "holes"
            ? [
                "center_x_in",
                "center_y_in",
                ...(v.shape === "slot"
                  ? ["width_in", "length_in", "angle_deg"]
                  : ["diameter_in"]),
                "count",
              ]
            : group === "bends"
              ? ["angle_deg", "inside_radius_in", "length_in", "count"]
              : [
                  "process",
                  "joint_type",
                  "joint_configuration",
                  "size_in",
                  "length_in",
                  "increment_in",
                  "pitch_in",
                  "position",
                  "count",
                  "sides",
                  "cross_section_area_in2",
                  "stitches_per_side",
                ];
        fields(
          v,
          [...base, group, String(n)],
          (group === "holes" ? "Hole" : group === "bends" ? "Bend" : "Weld") +
            " " +
            (n + 1),
          keys,
          group === "holes"
            ? [Number(v.center_x_in), Number(v.center_y_in)]
            : undefined,
        );
      });
  });
  const released =
    locked &&
    job.state === "ready" &&
    job.review_log.some((e) => e.version === job.version) &&
    JSON.stringify(ast) === JSON.stringify(job.ast);
  const fileBase =
    "/api/blueprints/jobs/" + job.id + "/shop-files/" + job.version + "/";
  return (
    <>
      {released && (
        <details>
          <summary>Reviewed shop files · revision {job.version}</summary>
          <p>
            <a href={fileBase + "0"}>Shop PDF</a>
          </p>
          {parts.map((p, i) => (
            <p key={i}>
              <a href={fileBase + (i + 1)}>
                Full-size DXF · {String(p.part_id)}
              </a>
            </p>
          ))}
        </details>
      )}
      {pageCount > 1 && (
        <label className="field">
          Drawing page
          <select
            value={page}
            onChange={(e) => setPage(Number(e.target.value))}
          >
            {Array.from({ length: pageCount }, (_, i) => (
              <option key={i}>{i + 1}</option>
            ))}
          </select>
        </label>
      )}
      {!!failure && <p role="alert">{failure}</p>}
      {preview?.src !== src ? (
        <p><Activity>Opening drawing page</Activity></p>
      ) : (
        <BlueprintCanvas
          src={preview.url}
          endpoint={"/api/blueprints/jobs/" + job.id + "/proof"}
          payload={{ version: job.version, ast, settings }}
          anchors={anchors}
          marks={marks}
          locked={locked}
          page={page}
          parts={
            pageParts.length ? pageParts : parts.map((p) => String(p.part_id))
          }
          onAlign={(id, points, bounds) => {
            const index = parts.findIndex((p) => p.part_id === id);
            onChange(["parts", String(index), "page_frame"], {
              lower_left: { page, ...points[0] },
              lower_right: { page, ...points[1] },
              upper_left: { page, ...points[2] },
              cad_bounds_in: bounds,
            });
          }}
        />
      )}
    </>
  );
}
