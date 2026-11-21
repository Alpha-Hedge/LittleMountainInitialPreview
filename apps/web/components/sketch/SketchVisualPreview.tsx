"use client";

import Activity from "@/components/Activity";
import { useEffect, useState } from "react";
import { sketchRequest } from "./request";

type Preview = {
  state: "idle" | "queued" | "rendering" | "ready" | "failed";
  error?: string;
  asset?: string | null;
  update_available?: boolean;
  audit?: {
    status: "checked" | "unavailable";
    findings: { issue: string; evidence: string }[];
    rods_withheld?: boolean;
    clearances: { part: string; opening: string; gap: number; units: string; approximate: boolean }[];
  } | null;
};

export default function SketchVisualPreview({ base, version, hasPhoto }: { base: string; version: number; hasPhoto: boolean }) {
  const query = "?version=" + version;
  const endpoint = base + "/visual" + query;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const saved = await sketchRequest<Preview>(endpoint, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPreview(saved);
        if (saved.state === "queued" || saved.state === "rendering") timer = setTimeout(load, 2500);
      } catch (error) {
        if (!controller.signal.aborted) {
          setPreview((previous) => ({
            ...previous, state: "failed",
            error: error instanceof Error ? error.message : "Could not open the drawing.",
          }));
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, refresh]);

  async function generate(newImage = false) {
    setSubmitting(true);
    try {
      const target = endpoint + (newImage ? "&new_image=true" : preview?.asset ? "&redo=true" : "");
      setPreview(await sketchRequest<Preview>(target, { method: "POST" }));
      setRefresh((n) => n + 1);
    } catch (error) {
      setPreview((previous) => ({
        ...previous, state: "failed",
        error: error instanceof Error ? error.message : "Could not start the drawing.",
      }));
    } finally {
      setSubmitting(false);
    }
  }

  const pending = submitting || preview?.state === "queued" || preview?.state === "rendering";
  const image = base + "/visual/image" + query + "&asset=" + (preview?.asset || "");
  const pdf = base + "/visual/pdf" + query + "&download=true";
  return (
    <section className="panel sk-card ph-visual" aria-labelledby="presentation-drawing-heading">
      <div className="ph-visual-header">
        <div>
          <h2 id="presentation-drawing-heading">Illustrated drawing</h2>
          <p>{preview?.asset ? "Open the sheet to see the full-size views and dimensions." : "Make a review drawing from the measurements on this sketch."}</p>
        </div>
        {preview?.asset && <a className="button primary" href={pdf}>Download drawing PDF</a>}
        {!preview?.asset && (
            <button type="button" className="button primary" disabled={!preview || pending} onClick={() => generate()}>
            {pending ? <Activity>Making drawing</Activity> : preview?.state === "failed" ? "Try again" : "Make drawing"}
          </button>
        )}
      </div>
      {preview?.error && <p className="sk-danger" role="alert">{preview.error}</p>}
      <div role="status">{pending ? <Activity>Building the sheet and checking the sketch</Activity> :
        preview?.state==="ready" && preview.asset ? <Activity done>Drawing ready</Activity> : !preview ? <Activity>Opening saved drawing</Activity> : null}</div>
      {!preview?.asset && hasPhoto && <figure className="ph-original-thumb"><img src={base + "/preview/page"} alt="Original sketch for this drawing sheet"/><figcaption>Original sketch</figcaption></figure>}
      {preview?.asset && (
        <>
          <a className="ph-visual-sheet" href={image} target="_blank" rel="noreferrer" aria-label="Open full-size AI drawing">
            <img src={image} alt="AI drawing sheet with an isometric illustration, measured part detail, and review notes" />
          </a>
          <div className="ph-visual-actions">
 
            <a className="button secondary" href={image + "&download=true"}>Download image</a>
            {preview.update_available && (
              <button className="button secondary" type="button" disabled={pending} onClick={() => generate()}>
                Update drawing
              </button>
            )}
            <button className="button secondary" type="button" disabled={pending} onClick={() => generate(true)}>
              Generate new illustration
            </button>
          </div>
          {preview.audit && (
            <details className="ph-visual-audit">
              <summary>{preview.audit.status === "unavailable" ? "Automatic sketch check incomplete" :
                preview.audit.findings.length ? `Sketch check · ${preview.audit.findings.length} items to review` :
                "Sketch check · no specific discrepancies found"}</summary>
              {preview.audit.status === "unavailable" && <p>Compare the source and the views before using the drawing.</p>}
              {preview.audit.rods_withheld && <p>The comparison left disputed rod locations open in the top and side views.</p>}
              {preview.audit.findings.length > 0 && (
                <ul>{preview.audit.findings.map((finding, i) => (
                  <li key={i}><strong>{finding.issue}</strong> {finding.evidence}</li>
                ))}</ul>
              )}
              {preview.audit.clearances.map((detail, i) => (
                <p key={i}>
                  {detail.part} {detail.opening} has {detail.approximate ? "about " : ""}
                  {detail.gap} {detail.units} of drawn opening-to-edge clearance. Verify engineering suitability separately.
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
