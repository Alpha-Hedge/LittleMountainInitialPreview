"use client";

import { useEffect, useState } from "react";
import type { DrawingRevision } from "@/lib/drawing-types";
import Activity from "./Activity";
import { Icon } from "./Icons";

type Props = {
  quoteId: string;
  revision: DrawingRevision;
  page: number;
  onPageChange: (page: number) => void;
  notes: string;
  active: boolean;
};

export default function ReviewSource({ quoteId, revision, page, onPageChange, notes, active }: Props) {
  const file = "/api/drawings/" + encodeURIComponent(quoteId) + "/" + encodeURIComponent(revision.id);
  const pdf = revision.mimeType === "application/pdf";
  const original = pdf ? file + "#page=" + page : file;
  const pageUrl = pdf ? file + "?page=" + page : null;
  const [loaded, setLoaded] = useState<{ key: string; src: string; count: number } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);

  useEffect(() => {
    if (!pageUrl) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    async function load(url: string) {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error((await response.json()).error || "Preview unavailable.");
        const count = Number(response.headers.get("X-Total-Pages"));
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setError(null);
        setLoaded({ key: url, src: objectUrl, count });
      } catch (err) {
        if (!controller.signal.aborted) setError({ key: url, message: err instanceof Error ? err.message : "Preview unavailable." });
      }
    }
    void load(pageUrl);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [pageUrl]);

  const displayed = !pdf ? file : loaded?.key === pageUrl ? loaded.src : null;
  const failure = error && error.key === (pageUrl || file) ? error.message : null;
  const count = loaded?.key.startsWith(file + "?page=") ? loaded.count : null;
  return <aside className="panel source-panel" id="review-source" tabIndex={-1} aria-label="Source drawing">
    <div className="panel-heading"><span className="section-icon"><Icon name="drawing"/></span><h2>Source drawing</h2></div>
    <div className="source-meta"><strong>{revision.fileName}</strong><small>Revision {revision.label} · {active ? "Selected on quote" : "Earlier revision"}</small></div>
    <div className="source-page">
      {failure ? <p role="alert">{failure}</p> : displayed ?
        <a href={original} target="_blank" rel="noreferrer" aria-label="Open full-size original drawing in a new tab">
          <img className="review-source-image" src={displayed} alt={revision.fileName + (pdf ? ", page " + page : "")}
            onError={() => setError({ key: pageUrl || file, message: "Preview unavailable. Open the original file." })}/>
        </a> : <p role="status"><Activity>Opening page {page}</Activity></p>}
    </div>
    <div className="source-toolbar">
      {pdf && <div className="source-pagination">
        <button type="button" aria-label="Previous drawing page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }}/></button>
        <span aria-live="polite">Page {page}{count ? " of " + count : ""}</span>
        <button type="button" aria-label="Next drawing page" disabled={!count || page >= count} onClick={() => onPageChange(page + 1)}>
          <Icon name="chevron" size={13}/></button>
      </div>}
      <a className="source-open" href={original} target="_blank" rel="noreferrer">Open original <Icon name="arrow" size={14}/></a>
    </div>
    <div className="source-notes" id="source-notes" tabIndex={-1}><h3>Customer notes</h3><p>{notes || "No customer notes."}</p></div>
  </aside>;
}
