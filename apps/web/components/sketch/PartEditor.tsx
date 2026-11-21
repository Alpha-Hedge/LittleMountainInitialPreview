"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@/components/Icons";
import type { SketchHole, SketchPart } from "@/lib/sketch/types";

const emptyHole: SketchHole = {
  shape: "round",
  centerX: null,
  centerY: null,
  diameter: null,
  width: null,
  length: null,
  angle: null,
};

export type CornerEdit = { index: number; x: number | null; y: number | null };

function readMeasurement(raw: string) {
  const text = raw.trim().replace(/\s+/g, " ");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  const fraction = /^(-?)(?:(\d+)[ -])?(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (!fraction || Number(fraction[4]) === 0) return null;
  const value =
    (Number(fraction[2] ?? 0) + Number(fraction[3]) / Number(fraction[4])) *
    (fraction[1] === "-" ? -1 : 1);
  return Number.isFinite(value) ? value : null;
}

export function SketchField({
  label,
  children,
  wide,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={"sk-field" + (wide ? " sk-field-wide" : "")}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Measurement({
  label,
  value,
  onChange,
  whole,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  whole?: boolean;
  placeholder?: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && typed.trim() !== "" && value === null;
  return (
    <SketchField label={label}>
      <input
        type="text"
        inputMode={whole ? "numeric" : undefined}
        maxLength={40}
        value={typed ?? value ?? ""}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          const raw = event.target.value;
          const number = readMeasurement(raw);
          setTyped(raw);
          onChange(whole && !Number.isInteger(number) ? null : number);
        }}
        onBlur={() => setTyped(null)}
      />
    </SketchField>
  );
}

export default function PartEditor({
  part,
  index,
  onChange,
  remove,
  corner,
  onCorner,
  editingCorner,
}: {
  part: SketchPart;
  index: number;
  onChange: (part: SketchPart) => void;
  remove?: () => void;
  corner: CornerEdit | null;
  onCorner: (corner: CornerEdit | null) => void;
  editingCorner: boolean;
}) {
  const { outline, holes } = part;
  const bends = part.bendLines ?? [];
  function updateBend(i: number, change: Partial<(typeof bends)[number]>) {
    onChange({ ...part, bendLines: bends.map((bend, j) => j === i ? { ...bend, ...change } : bend) });
  }
  function updateOutline(update: Partial<SketchPart["outline"]>) {
    onChange({ ...part, outline: { ...outline, ...update } });
  }
  function updateHole(holeIndex: number, hole: SketchHole) {
    onChange({
      ...part,
      holes: holes.map((value, i) => (i === holeIndex ? hole : value)),
    });
  }
  const number = index + 1;
  const heading = part.name
    ? "Part " + number + " · " + part.name
    : "Part " + number;
  return (
    <section
      className="panel sk-card sk-part"
      aria-labelledby={"sk-part-" + index}
    >
      <div className="sk-card-head">
        <h2 id={"sk-part-" + index}>{heading}</h2>
        {remove && (
          <button
            type="button"
            className="sk-plain"
            onClick={remove}
            disabled={editingCorner}
          >
            <Icon name="trash" size={17} /> Remove part
          </button>
        )}
      </div>
      <div className="sk-form-grid">
        <SketchField label="Part name">
          <input
            value={part.name}
            maxLength={100}
            placeholder="e.g. Mounting plate"
            onChange={(e) => onChange({ ...part, name: e.target.value })}
          />
        </SketchField>
        <Measurement
          label="Quantity"
          whole
          value={part.quantity}
          onChange={(quantity) => onChange({ ...part, quantity })}
        />
        <SketchField label="Material and grade">
          <input
            value={part.material}
            maxLength={100}
            placeholder="e.g. A36 steel"
            onChange={(e) => onChange({ ...part, material: e.target.value })}
          />
        </SketchField>
        <Measurement
          label="Thickness"
          value={part.thickness}
          onChange={(thickness) => onChange({ ...part, thickness })}
        />
      </div>
      <div className="sk-subsection">
        <h3>Outside shape</h3>
        <div className="sk-form-grid">
          <SketchField label="Shape" wide>
            <select
              value={outline.kind}
              onChange={(e) => {
                if (corner) onCorner(null);
                updateOutline({
                  kind: e.target.value as SketchPart["outline"]["kind"],
                });
              }}
            >
              <option value="unknown">Choose shape</option>
              <option value="rectangle">Rectangle</option>
              <option value="polygon">Straight-sided outline</option>
            </select>
          </SketchField>
          {outline.kind === "rectangle" && (
            <>
              <Measurement
                label="Outside width (left to right)"
                value={outline.width}
                onChange={(width) => updateOutline({ width })}
              />
              <Measurement
                label="Outside height (bottom to top)"
                value={outline.height}
                onChange={(height) => updateOutline({ height })}
              />
              <Measurement
                label="Corner radius"
                value={outline.cornerRadius}
                placeholder="0 for square corners"
                onChange={(cornerRadius) => updateOutline({ cornerRadius })}
              />
            </>
          )}
        </div>
        {outline.kind === "polygon" && (
          <div className="sk-corners">
            <p>
              Enter at least three corners in order around the part. Use the
              same lower-left starting point for corners, holes, and slots.
            </p>
            <ol className="sk-inline-list">
              {outline.vertices.map((vertex, vertexIndex) => (
                <li key={vertexIndex}>
                  <span>
                    Corner {vertexIndex + 1} · X {vertex.x}, Y {vertex.y}
                  </span>
                  <button
                    type="button"
                    className="sk-plain"
                    disabled={editingCorner}
                    onClick={() => onCorner({ index: vertexIndex, ...vertex })}
                  >
                    Edit{" "}
                    <span className="visually-hidden">
                      corner {vertexIndex + 1}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {corner ? (
              <div className="sk-feature">
                <h4>
                  {corner.index < outline.vertices.length
                    ? "Edit corner " + (corner.index + 1)
                    : "New corner"}
                </h4>
                <div className="sk-form-grid">
                  <Measurement
                    label="X from left"
                    value={corner.x}
                    onChange={(x) => onCorner({ ...corner, x })}
                  />
                  <Measurement
                    label="Y from bottom"
                    value={corner.y}
                    onChange={(y) => onCorner({ ...corner, y })}
                  />
                </div>
                <div className="sk-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={corner.x === null || corner.y === null}
                    onClick={() => {
                      if (corner.x === null || corner.y === null) return;
                      const vertices = [...outline.vertices];
                      vertices[corner.index] = { x: corner.x, y: corner.y };
                      updateOutline({ vertices });
                      onCorner(null);
                    }}
                  >
                    Save corner
                  </button>
                  <button
                    type="button"
                    className="sk-plain"
                    onClick={() => onCorner(null)}
                  >
                    Cancel
                  </button>
                  {corner.index < outline.vertices.length && (
                    <button
                      type="button"
                      className="sk-plain"
                      onClick={() => {
                        updateOutline({
                          vertices: outline.vertices.filter(
                            (_, i) => i !== corner.index,
                          ),
                        });
                        onCorner(null);
                      }}
                    >
                      Remove corner
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="button secondary"
                disabled={editingCorner}
                onClick={() =>
                  onCorner({
                    index: outline.vertices.length,
                    x: null,
                    y: null,
                  })
                }
              >
                <Icon name="plus" size={17} /> Add corner
              </button>
            )}
          </div>
        )}
      </div>
      <div className="sk-subsection">
        <h3>Holes and slots</h3>
        {holes.length > 0 && (
          <p>
            Enter each center from the same lower-left starting point, with X to
            the right and Y up.
          </p>
        )}
        <div className="sk-feature-list">
          {holes.map((hole, holeIndex) => {
            const kind = hole.shape === "round" ? "Hole" : "Slot";
            return (
              <div className="sk-feature" key={holeIndex}>
                <div className="sk-card-head">
                  <h4>
                    {kind} {holeIndex + 1}
                  </h4>
                  <button
                    type="button"
                    className="sk-plain"
                    onClick={() =>
                      onChange({
                        ...part,
                        holes: holes.filter((_, i) => i !== holeIndex),
                      })
                    }
                  >
                    Remove{" "}
                    <span className="visually-hidden">
                      {kind.toLowerCase()} {holeIndex + 1}
                    </span>
                  </button>
                </div>
                <div className="sk-form-grid">
                  <Measurement
                    label="Center from left (X)"
                    value={hole.centerX}
                    onChange={(centerX) =>
                      updateHole(holeIndex, { ...hole, centerX })
                    }
                  />
                  <Measurement
                    label="Center from bottom (Y)"
                    value={hole.centerY}
                    onChange={(centerY) =>
                      updateHole(holeIndex, { ...hole, centerY })
                    }
                  />
                  {hole.shape === "round" ? (
                    <Measurement
                      label="Diameter"
                      value={hole.diameter}
                      onChange={(diameter) =>
                        updateHole(holeIndex, { ...hole, diameter })
                      }
                    />
                  ) : (
                    <>
                      <Measurement
                        label="Overall slot length"
                        value={hole.length}
                        onChange={(length) =>
                          updateHole(holeIndex, { ...hole, length })
                        }
                      />
                      <Measurement
                        label="Slot width"
                        value={hole.width}
                        onChange={(width) =>
                          updateHole(holeIndex, { ...hole, width })
                        }
                      />
                      <Measurement
                        label="Angle in degrees"
                        placeholder="0 for horizontal, 90 for vertical"
                        value={hole.angle}
                        onChange={(angle) =>
                          updateHole(holeIndex, { ...hole, angle })
                        }
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="sk-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              onChange({ ...part, holes: [...holes, { ...emptyHole }] })
            }
          >
            <Icon name="plus" size={17} /> Round hole
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              onChange({
                ...part,
                holes: [...holes, { ...emptyHole, shape: "slot" }],
              })
            }
          >
            <Icon name="plus" size={17} /> Slot
          </button>
        </div>
      </div>
      <div className="sk-subsection">
        <h3>Bend marks</h3>
        <p>Enter the start and end of each scribe line in drawing units. Measure X from the left and Y from the bottom.</p>
        {bends.map((bend, i) => (
          <div className="sk-feature" key={i}>
            <div className="sk-card-head">
              <h4>Bend {i + 1}</h4>
              <button type="button" className="sk-plain" aria-label={"Remove bend " + (i + 1)}
                onClick={() => onChange({ ...part, bendLines: bends.filter((_, j) => i !== j) })}>
                <Icon name="trash" size={16} /> Remove
              </button>
            </div>
            <div className="sk-form-grid">
              {(["start", "end"] as const).map(end =>
                (["x", "y"] as const).map(axis => (
                  <Measurement key={end + axis} label={(end === "start" ? "Start " : "End ") + axis.toUpperCase()}
                    value={bend[end][axis]} onChange={value => updateBend(i, { [end]: { ...bend[end], [axis]: value } })} />
                ))
              )}
              <SketchField label="Bend note (optional)" wide>
                <input value={bend.label} maxLength={100} placeholder="e.g. UP 90°"
                  onChange={(e) => updateBend(i, { label: e.target.value })} />
              </SketchField>
            </div>
          </div>
        ))}
        <button type="button" className="button secondary" onClick={() => onChange({
          ...part, bendLines: [...bends, { start: { x: null, y: null }, end: { x: null, y: null }, label: "" }],
        })}><Icon name="plus" size={17} /> Add bend mark</button>
      </div>
      <div className="sk-subsection">
        <SketchField label="Shop notes (optional)">
          <textarea
            value={part.notes}
            rows={2}
            maxLength={1000}
            placeholder="e.g. Deburr all edges"
            onChange={(e) => onChange({ ...part, notes: e.target.value })}
          />
        </SketchField>
      </div>
    </section>
  );
}
