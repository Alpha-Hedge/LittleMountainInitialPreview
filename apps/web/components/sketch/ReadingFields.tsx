"use client";

import { useState, type ReactNode } from "react";
import type {
  Mark,
  PhotoPart,
  ReadingKind,
} from "@/lib/sketch/conversion-types";
import type { Point } from "@/lib/sketch/types";

export const fieldNames: Record<ReadingKind, string> = {
  width: "Overall width",
  height: "Overall height",
  radius: "Corner radius",
  quantity: "Piece count",
  material: "Material",
  thickness: "Thickness",
  x: "X from datum",
  y: "Y from datum",
  dx: "Horizontal spacing",
  dy: "Vertical spacing",
  from_right: "Offset from right edge",
  from_top: "Offset from top edge",
  center_x: "Centered across width",
  center_y: "Centered across height",
  length: "Length",
  angle: "Edge bearing",
  hole_callout: "Hole callout",
  diameter: "Hole diameter",
  slot_width: "Slot width",
  slot_length: "Slot length",
  slot_angle: "Slot direction",
  bend_angle: "Bend angle",
  bend_direction: "Bend direction",
  weld: "Weld callout",
  note: "Shop note",
  unsupported: "Unresolved instruction",
};
export function targetName(target: string) {
  if (target === "P") return "Part";
  const match = /^([EVHB])(\d+)(\.[ab])?$/.exec(target);
  return match
    ? { E: "Edge", V: "Corner", H: "Opening", B: "Bend" }[match[1]] +
        " " +
        match[2] +
        (match[3] === ".a" ? " start" : match[3] === ".b" ? " end" : "")
    : target;
}

export function ReadingFields({
  part,
  onChange,
  onLocate,
  locked,
  children,
}: {
  part: PhotoPart;
  onChange: (part: PhotoPart) => void;
  onLocate: (point: Point, targets: string[]) => void;
  locked: boolean;
  children?: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [initiallyOpen] = useState(!part.annotations.length);
  const [kind, setKind] = useState<ReadingKind>("width");
  const [target, setTarget] = useState("P");
  const [value, setValue] = useState("");
  function edit(index: number, change: Partial<Mark>) {
    const annotations = part.annotations.map((a, i) =>
      i === index ? { ...a, ...change } : a,
    );
    onChange({ ...part, annotations });
  }
  function add() {
    const targets = target
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!value.trim() || !targets.length) return;
    const at = part.vertices[0] || { x: 500, y: 500 };
    onChange({
      ...part,
      annotations: [
        ...part.annotations,
        {
          kind,
          targets,
          value: value.trim(),
          evidence: "Staff confirmed " + value.trim(),
          confidence: 1,
          at,
        },
      ],
    });
    setValue("");
    setAdding(false);
  }
  const featureIds = [
    "P",
    ...part.vertices.flatMap((_, i) => ["V" + (i + 1), "E" + (i + 1)]),
    ...part.holes.map((_, i) => "H" + (i + 1)),
    ...part.bends.flatMap((_, i) => [
      "B" + (i + 1),
      "B" + (i + 1) + ".a",
      "B" + (i + 1) + ".b",
    ]),
  ];
  return (
    <details id={"reading-part-"+part.part_id} className="panel sk-card ph-fields" open={initiallyOpen || undefined}>
      <summary className="part-fold-heading"><strong>{part.name}</strong><span>{part.annotations.length} readings</span></summary>
      <p>
        {part.shape === "rectangle"
          ? "Rectangular blank"
          : part.shape === "polygon"
            ? "Straight-sided blank"
            : "Outline needs checking"}{" "}
        · {part.holes.length} openings · {part.bends.length} bend lines
      </p>
      {part.annotations.map((a, i) => (
        <div className="ph-field" key={i} id={"mark-" + part.part_id + "-" + i}>
          <label>
            <span>
              {fieldNames[a.kind]}{" "}
              <small>{a.targets.map(targetName).join(", ")}</small>
            </span>
            <input
              value={a.value}
              disabled={locked}
              onFocus={() => onLocate(a.at, a.targets)}
              onChange={(e) =>
                edit(i, {
                  value: e.target.value,
                  evidence: "Staff confirmed " + e.target.value,
                  confidence: 1,
                })
              }
            />
          </label>
          <details>
            <summary>Source and feature</summary>
            <p>
              {a.evidence} · {Math.round(a.confidence * 100)}% confidence
            </p>
            <button
              className="ph-link"
              type="button"
              onClick={() => onLocate(a.at, a.targets)}
            >
              Locate on photo
            </button>
            {!locked && (
              <div className="ph-binding">
                <label>
                  Applies to{" "}
                  <input
                    aria-label={"Feature for " + fieldNames[a.kind]}
                    defaultValue={a.targets.join(", ")}
                    onBlur={(e) => {
                      const refs = e.target.value
                        .split(",")
                        .map((t) => t.trim())
                        .filter(Boolean);
                      if (refs.join() !== a.targets.join() && refs.length)
                        edit(i, { targets: refs, confidence: 1 });
                    }}
                  />
                </label>
                <label>
                  Reading type{" "}
                  <select
                    value={a.kind}
                    onChange={(e) =>
                      edit(i, {
                        kind: e.target.value as ReadingKind,
                        confidence: 1,
                      })
                    }
                  >
                    {Object.entries(fieldNames).map(([k, name]) => (
                      <option key={k} value={k}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <small>
                  Feature references on this part: {featureIds.join(", ")}
                </small>
                <button
                  type="button"
                  className="ph-link"
                  onClick={() =>
                    onChange({
                      ...part,
                      annotations: part.annotations.filter((_, n) => n !== i),
                    })
                  }
                >
                  Remove this reading from the revision
                </button>
              </div>
            )}
          </details>
        </div>
      ))}
      {!locked &&
        (adding ? (
          <div className="ph-add">
            <label>
              Measurement or note{" "}
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as ReadingKind)}
              >
                {Object.entries(fieldNames).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Applies to{" "}
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                list={"targets-" + part.part_id}
              />
            </label>
            <datalist id={"targets-" + part.part_id}>
              {featureIds.map((k) => (
                <option key={k} value={k}>
                  {targetName(k)}
                </option>
              ))}
            </datalist>
            <label>
              Confirmed value{" "}
              <input value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            <button
              type="button"
              className="button secondary"
              onClick={add}
              disabled={!value.trim()}
            >
              Add reading
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="ph-link"
            onClick={() => setAdding(true)}
          >
            + Add a measurement or shop note
          </button>
        ))}
      {children}
    </details>
  );
}
