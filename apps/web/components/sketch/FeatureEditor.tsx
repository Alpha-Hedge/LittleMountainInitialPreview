"use client";

import { useState } from "react";
import type {
  PhotoPart,
  SketchConversion,
} from "@/lib/sketch/conversion-types";
import type { Point } from "@/lib/sketch/types";
import { targetName } from "./ReadingFields";

export type FeaturePoint = { part: number; key: string };
export function featurePoints(part: PhotoPart) {
  return [
    ...part.vertices.map((at, i) => ({ key: "V" + (i + 1), at })),
    ...part.holes.map((h, i) => ({ key: "H" + (i + 1), at: h.at })),
    ...part.bends.flatMap((b, i) => [
      { key: "B" + (i + 1) + ".a", at: b.start },
      { key: "B" + (i + 1) + ".b", at: b.end },
    ]),
  ];
}
export function movedPoint(part: PhotoPart, key: string, at: Point): PhotoPart {
  const index = Number(key.match(/\d+/)?.[0]) - 1;
  if (key.startsWith("V"))
    return {
      ...part,
      vertices: part.vertices.map((p, i) => (i === index ? at : p)),
    };
  if (key.startsWith("H"))
    return {
      ...part,
      holes: part.holes.map((h, i) =>
        i === index ? { ...h, at, confidence: 1 } : h,
      ),
    };
  return {
    ...part,
    bends: part.bends.map((b, i) =>
      i === index
        ? { ...b, [key.endsWith(".a") ? "start" : "end"]: at, confidence: 1 }
        : b,
    ),
  };
}
export function targetPoint(
  part: PhotoPart,
  target: string,
): Point | undefined {
  const points = featurePoints(part);
  if (target.startsWith("E") || target === "P") {
    const i = Number(target.slice(1)) - 1;
    const vertices =
      target === "P"
        ? part.vertices
        : [
            part.vertices[i],
            part.vertices[(i + 1) % part.vertices.length],
          ].filter(Boolean);
    return vertices.length
      ? {
          x: vertices.reduce((s, p) => s + p.x, 0) / vertices.length,
          y: vertices.reduce((s, p) => s + p.y, 0) / vertices.length,
        }
      : undefined;
  }
  return points.find((p) => p.key === target || p.key === target + ".a")?.at;
}

export default function FeatureEditor({
  part,
  index,
  candidates,
  onChange,
  begin,
}: {
  part: PhotoPart;
  index: number;
  candidates: NonNullable<SketchConversion["evidence"]["candidates"]>;
  onChange: (part: PhotoPart) => void;
  begin: (choice: FeaturePoint) => void;
}) {
  const [selected, setSelected] = useState("P");
  const points = featurePoints(part),
    center = part.vertices[0] || { x: 500, y: 500 };
  const hole = selected.startsWith("H") ? Number(selected.slice(1)) - 1 : -1;
  const bend = selected.startsWith("B") ? Number(selected.slice(1)) - 1 : -1;
  const binding =
    hole >= 0 ? part.holes[hole] : bend >= 0 ? part.bends[bend] : part;
  const removing =
    selected === "P"
      ? [
          "V" + part.vertices.length,
          "E" + part.vertices.length,
          "E" + (part.vertices.length - 1),
        ]
      : [selected, selected + ".a", selected + ".b"];
  const referenced = part.annotations.some((mark) =>
    mark.targets.some((t) => removing.includes(t)),
  );
  function removeFeature() {
    if (referenced) return;
    if (selected === "P") {
      onChange({ ...part, vertices: part.vertices.slice(0, -1) });
      return;
    }
    const family = selected.charAt(0),
      number = Number(selected.slice(1));
    const annotations = part.annotations.map((a) => ({
      ...a,
      targets: a.targets.map((t) => {
        const match = /^([HB])(\d+)(.*)$/.exec(t);
        return match && match[1] === family && Number(match[2]) > number
          ? family + (Number(match[2]) - 1) + match[3]
          : t;
      }),
    }));
    onChange({
      ...part,
      annotations,
      holes: part.holes.filter((_, i) => i !== hole),
      bends: part.bends.filter((_, i) => i !== bend),
    });
    setSelected("P");
  }
  function bind(value: string) {
    const next = { candidate: value || null, confidence: 1 };
    if (hole >= 0)
      onChange({
        ...part,
        holes: part.holes.map((h, i) => (i === hole ? { ...h, ...next } : h)),
      });
    else if (bend >= 0)
      onChange({
        ...part,
        bends: part.bends.map((b, i) => (i === bend ? { ...b, ...next } : b)),
      });
    else onChange({ ...part, ...next });
  }
  return (
    <details className="ph-feature">
      <summary>Correct a shape or its location</summary>
      <label>
        Part name
        <input
          value={part.name}
          onChange={(e) => onChange({ ...part, name: e.target.value })}
        />
      </label>
      <label>
        Part ID
        <input
          value={part.part_id}
          onChange={(e) => onChange({ ...part, part_id: e.target.value })}
        />
      </label>
      <p>
        Use photo points to identify features. Enter their written dimensions in
        the measurement fields.
      </p>
      <label>
        Feature
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="P">Outside profile</option>
          {part.holes.map((_, i) => (
            <option key={i} value={"H" + (i + 1)}>
              Opening {i + 1}
            </option>
          ))}
          {part.bends.map((_, i) => (
            <option key={i} value={"B" + (i + 1)}>
              Bend {i + 1}
            </option>
          ))}
        </select>
      </label>
      {selected === "P" && (
        <label>
          Outside shape
          <select
            value={part.shape}
            onChange={(e) =>
              onChange({
                ...part,
                shape: e.target.value as PhotoPart["shape"],
                confidence: 1,
              })
            }
          >
            <option value="unknown">Needs checking</option>
            <option value="rectangle">Rectangle</option>
            <option value="polygon">Straight-sided outline</option>
          </select>
        </label>
      )}
      {hole >= 0 && binding && (
        <label>
          Opening shape
          <select
            value={part.holes[hole].shape}
            onChange={(e) =>
              onChange({
                ...part,
                holes: part.holes.map((h, i) =>
                  i === hole
                    ? {
                        ...h,
                        shape: e.target.value as "slot" | "round" | "unknown",
                        confidence: 1,
                      }
                    : h,
                ),
              })
            }
          >
            <option value="unknown">Needs checking</option>
            <option value="round">Round through-hole</option>
            <option value="slot">Straight slot</option>
          </select>
        </label>
      )}
      <label>
        Detected mark
        <select
          value={binding?.candidate || ""}
          onChange={(e) => bind(e.target.value)}
        >
          <option value="">Located by hand</option>
          {candidates.map((c) => (
            <option value={c.id} key={c.id}>
              {c.id} · {c.kind}
            </option>
          ))}
        </select>
      </label>
      <div className="ph-feature-actions">
        {(selected !== "P" || part.vertices.length > 0) && (
          <button
            className="ph-link"
            type="button"
            disabled={referenced}
            title={
              referenced
                ? "Move or remove readings attached to this feature first."
                : undefined
            }
            onClick={removeFeature}
          >
            {selected === "P"
              ? "Remove last corner"
              : "Remove " + targetName(selected).toLowerCase()}
          </button>
        )}
        {points
          .filter((p) =>
            selected === "P"
              ? p.key.startsWith("V")
              : p.key === selected || p.key.startsWith(selected + "."),
          )
          .map((p) => (
            <button
              type="button"
              key={p.key}
              className="ph-link"
              onClick={() => begin({ part: index, key: p.key })}
            >
              Locate {targetName(p.key).toLowerCase()}
            </button>
          ))}
      </div>
      <div className="sk-actions">
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            onChange({ ...part, vertices: [...part.vertices, center] });
            setSelected("P");
            begin({ part: index, key: "V" + (part.vertices.length + 1) });
          }}
        >
          Add corner
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            const id = "H" + (part.holes.length + 1);
            onChange({
              ...part,
              holes: [
                ...part.holes,
                { shape: "round", confidence: 1, candidate: null, at: center },
              ],
            });
            setSelected(id);
            begin({ part: index, key: id });
          }}
        >
          Add opening
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            const id = "B" + (part.bends.length + 1);
            onChange({
              ...part,
              bends: [
                ...part.bends,
                { start: center, end: center, candidate: null, confidence: 1 },
              ],
            });
            setSelected(id);
            begin({ part: index, key: id + ".a" });
          }}
        >
          Add bend line
        </button>
      </div>
    </details>
  );
}
