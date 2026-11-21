"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Line, Path, StaticCanvas } from "fabric";
import { Button } from "@/components/ui/button";
import { polylinePath } from "@/lib/sketch/geometry";
import type { Point, SketchDraft } from "@/lib/sketch/types";
import { sketchRequest } from "./request";

type Cut = { layer: string; vertices: [number, number, number][] };
type Geometry = {
  bounds: [number, number, number, number];
  contours: Cut[];
  bends: { start: Point; end: Point }[];
};
type PreviewResult = { key: string; geometry?: Geometry; error?: string };

const format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const colors = { outer: "#98e1cd", inner: "#f8bf86", bend: "#9acbff" };

function GeometryCanvas({ geometry, partName }: { geometry: Geometry; partName: string }) {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLCanvasElement>(null);
  const controller = useRef<{ setZoom: (value: number) => void; fit: () => void } | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!host.current || !element.current) return;
    const container = host.current;
    const canvas = new StaticCanvas(element.current, { renderOnAddRemove: false, skipOffscreen: false });
    const [left, bottom, right, top] = geometry.bounds;
    const spanX = right - left, spanY = top - bottom;
    let magnification = 1, offsetX = 0, offsetY = 0;
    let drag: { x: number; y: number; pointer: number } | undefined;
    const cuts = geometry.contours.map((contour) => {
      const outer = contour.layer === "0_CUT_OUTER";
      const path = polylinePath(contour.vertices.map(([x, y, bulge]) => ({ x, y, bulge })));
      return new Path(path, {
        fill: outer ? "#25423f" : "#18272d",
        stroke: outer ? colors.outer : colors.inner, strokeLineJoin: "round",
        objectCaching: false,
      });
    });
    const bends = geometry.bends.map(({ start, end }) =>
      new Line([start.x, start.y, end.x, end.y], { stroke: colors.bend, objectCaching: false })
    );
    canvas.add(...cuts, ...bends);

    function redraw() {
      const width = container.clientWidth, height = container.clientHeight;
      if (width < 2 || height < 2 || spanX <= 0 || spanY <= 0) return;
      if (canvas.getWidth() !== width || canvas.getHeight() !== height) canvas.setDimensions({ width, height });
      const scale = magnification * Math.min((width - 40) / spanX, (height - 40) / spanY);
      if (scale <= 0) return;
      canvas.setViewportTransform([
        scale, 0, 0, -scale,
        width / 2 - scale * (left + right) / 2 + offsetX,
        height / 2 + scale * (bottom + top) / 2 + offsetY,
      ]);
      for (const cut of cuts) cut.set("strokeWidth", 1.7 / scale);
      for (const bend of bends) bend.set({ strokeWidth: 1.5 / scale, strokeDashArray: [7 / scale, 4 / scale] });
      canvas.renderAll();
    }
    function shift(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointer) return;
      offsetX += event.clientX - drag.x;
      offsetY += event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      redraw();
    }
    function start(event: PointerEvent) {
      if (event.button !== 0 || drag) return;
      container.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, pointer: event.pointerId };
    }
    function end(event: PointerEvent) {
      if (drag?.pointer === event.pointerId) drag = undefined;
    }
    function keyboard(event: KeyboardEvent) {
      const shifts: Record<string, [number, number]> = { ArrowLeft: [24, 0], ArrowRight: [-24, 0], ArrowUp: [0, 24], ArrowDown: [0, -24] };
      if (!shifts[event.key]) return;
      event.preventDefault();
      offsetX += shifts[event.key][0];
      offsetY += shifts[event.key][1];
      redraw();
    }
    controller.current = {
      setZoom(value) { magnification = value; setZoom(value); redraw(); },
      fit() { offsetX = 0; offsetY = 0; this.setZoom(1); },
    };
    setZoom(1);
    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    container.addEventListener("keydown", keyboard);
    container.addEventListener("pointerdown", start);
    container.addEventListener("pointermove", shift);
    container.addEventListener("lostpointercapture", end);
    redraw();
    return () => {
      controller.current = null;
      observer.disconnect();
      container.removeEventListener("keydown", keyboard);
      container.removeEventListener("pointerdown", start);
      container.removeEventListener("pointermove", shift);
      container.removeEventListener("lostpointercapture", end);
      canvas.cancelRequestedRender();
      void canvas.dispose();
    };
  }, [geometry]);

  return <>
    <div className="sk-cad-viewport" ref={host} tabIndex={0} role="img" aria-label={partName + " plan view. Drag or use arrow keys to pan."}>
      <canvas ref={element} />
    </div>
    <div className="sk-viewport-toolbar" aria-label="Drawing view controls">
      <Button type="button" variant="outline" size="compact" onClick={() => controller.current?.setZoom(zoom / 2)} disabled={zoom <= 0.5} aria-label="Zoom out">−</Button>
      <output aria-label="View zoom">{Math.round(zoom * 100)}%</output>
      <Button type="button" variant="outline" size="compact" onClick={() => controller.current?.setZoom(zoom * 2)} disabled={zoom >= 8} aria-label="Zoom in">+</Button>
      <Button type="button" variant="outline" size="compact" onClick={() => controller.current?.fit()}>Fit part</Button>
    </div>
  </>;
}

export default function SketchPreview({ draft, index, endpoint }: { draft: SketchDraft; index: number; endpoint: string }) {
  const part = draft.parts[index];
  const draftKey = useMemo(() => JSON.stringify({ draft: { title: draft.title, units: draft.units, parts: part ? [part] : [] } }), [draft.title, draft.units, part]);
  const ready = !!(part && draft.units && part.name && part.material && part.quantity && part.thickness && part.outline.kind !== "unknown");
  const [result, setResult] = useState<PreviewResult | null>(null);
  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      sketchRequest<{ parts: Geometry[] }>(endpoint + "/preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: draftKey, signal: abort.signal,
      }).then(({ parts }) => {
        if (!abort.signal.aborted) setResult({ key: draftKey, geometry: parts[0] });
      }).catch((error: Error) => {
        if (!abort.signal.aborted) setResult({ key: draftKey, error: error.message });
      });
    }, 420);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [ready, draftKey, endpoint]);
  const current = result?.key === draftKey ? result : null;
  if (!ready || !current?.geometry) return <p className="sk-empty-preview" role="status">
    {!ready ? "Enter the material, thickness, quantity, units and outline to inspect this part." : current?.error || "Checking part geometry…"}
  </p>;
  const { bounds, contours, bends } = current.geometry;
  return <figure className="sk-cad">
    <div className="sk-cad-title"><span>Plan view</span><span>{format.format(bounds[2] - bounds[0])} × {format.format(bounds[3] - bounds[1])} {draft.units} overall</span></div>
    <GeometryCanvas geometry={current.geometry} partName={part.name} />
    <figcaption className="sk-cad-legend">
      <span><i />Outer cut</span>
      {contours.some(c => c.layer === "1_CUT_INNER") && <span><i className="inner" />Inner cut</span>}
      {bends.length > 0 && <span><i className="bend" />Bend mark</span>}
    </figcaption>
  </figure>;
}
