"use client";

import Activity from "@/components/Activity";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { maxDrawingBytes, type DrawingState } from "@/lib/drawing-types";
import { Icon } from "./Icons";
import "./drawing-panel.css";

function DrawingIcon({ name, size = 16 }: { name: "upload" | "expand" | "file" | "review" | "history"; size?: number }) {
  const paths = {
    upload: <><path d="M12 16V3m-5 5 5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
    expand: <path d="M14 4h6v6m0-6-7 7M10 20H4v-6m0 6 7-7"/>,
    file: <><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5M8.5 13h7m-7 3.5h5"/></>,
    review: <><path d="m10 3 2.1 6.1L18 11l-5.9 2-2.1 6-2-6-6-2 6-1.9zM18.5 14.5l1.1 3.1 3 1-3 1.1-1.1 3.1-1-3.1-3.1-1.1 3.1-1z"/></>,
    history: <><path d="M4 10a8.2 8.2 0 1 1 .5 6M4 5v5h5"/><path d="M12 7v5l3 2"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const accept = "application/pdf,image/png,image/jpeg,image/webp";
const emptyState: DrawingState = { attachments: [], selectedRevisionId: null };
function fileSize(size: number) {
  return size < 1048576 ? Math.max(1, Math.round(size / 1024)) + " KB" : (size / 1048576).toFixed(1) + " MB";
}

function UploadDialog({ data, onClose, onUpload }: {
  data: DrawingState;
  onClose: () => void;
  onUpload: (form: FormData) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="dp-dialog" aria-labelledby="upload-title" onCancel={e => { e.preventDefault(); if (!working) onClose(); }}>
    <div className="dp-dialog-heading"><h2 id="upload-title">Add a drawing</h2><button type="button" disabled={working} aria-label="Close" onClick={onClose}><Icon name="close"/></button></div>
    <form onSubmit={async e => {
      e.preventDefault();
      if (working) return;
      setError("");
      const form = new FormData(e.currentTarget);
      const file = form.get("file");
      if (!(file instanceof File) || !file.size || file.size > maxDrawingBytes) { setError("Choose a file between 1 byte and 20 MB."); return; }
      setWorking(true);
      try { await onUpload(form); onClose(); }
      catch (err) { setError(err instanceof Error ? err.message : "Upload failed."); setWorking(false); }
    }}>
      <label>Choose a drawing or photo <input type="file" name="file" accept={accept} required /></label>
      <div className="dp-hint">PDF, PNG, JPEG, or WebP · Up to 20 MB</div>
      {data.attachments.length > 0 && <label>Which drawing is this?<select name="attachmentId" defaultValue="">
        <option value="">A separate drawing</option>{data.attachments.map(d => <option key={d.id} value={d.id}>New version of {d.name}</option>)}
      </select></label>}
      <label>Revision on the drawing <span>(optional)</span><input name="label" maxLength={60} placeholder="e.g. A or 2" autoComplete="off"/></label>
      {data.attachments.length>0&&<p className="dp-hint">This will be the drawing used for the quote. Earlier files stay available.</p>}
      {error && <p className="dp-error" role="alert">{error}</p>}
      <div className="dp-dialog-actions"><button type="button" disabled={working} onClick={onClose}>Cancel</button><button type="submit" className="dp-primary" disabled={working}>{working ? <Activity>Uploading drawing</Activity> : "Use this drawing"}</button></div>
    </form>
  </dialog>, document.body);
}

export default function DrawingPanel({ quoteId, dirty = false, onDrawingChange, onSelectionChange }: { quoteId: string | null; dirty?: boolean; onDrawingChange?:()=>void; onSelectionChange?: (id: string | null) => void }) {
  const [data, setData] = useState<DrawingState>(emptyState);
  const [viewId, setViewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(quoteId));
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const endpoint = quoteId ? "/api/drawings/" + encodeURIComponent(quoteId) : null;

  useEffect(() => {
    const controller = new AbortController();
    setError(""); setHistoryOpen(false); setUploadOpen(false); setData(emptyState); setViewId(null); setLoading(Boolean(endpoint));
    if (!endpoint) return;
    fetch(endpoint, { signal: controller.signal, cache: "no-store" }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not open drawings.");
      if (!controller.signal.aborted) { setData(result); setViewId(result.selectedRevisionId); onSelectionChange?.(result.selectedRevisionId); }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, nonce, onSelectionChange]);

  async function saveRequest(init: RequestInit) {
    if (!endpoint) throw new Error("Save the quote before attaching a drawing.");
    const response = await fetch(endpoint, init);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The drawing could not be saved.");
    setData(result);
    setViewId(result.selectedRevisionId);
    onSelectionChange?.(result.selectedRevisionId);
    setError("");
    onDrawingChange?.();
  }

  const revisions = data.attachments.flatMap(a => a.revisions);
  const current = revisions.find(r => r.id === viewId);
  const inUse = current?.id === data.selectedRevisionId;
  const url = current ? endpoint + "/" + encodeURIComponent(current.id) : "";
  return <section className="dp-panel" id="drawings" tabIndex={-1} aria-label="Drawing preview">
    <div className="dp-head"><div className="dp-heading"><Icon name="drawing" size={20}/><h2>Drawings</h2></div>
      {current&&<button type="button" className="dp-upload" disabled={!quoteId || loading} onClick={() => setUploadOpen(true)}><DrawingIcon name="upload" size={16}/> Add drawing</button>}</div>
    {current ? <>
      <div className="dp-paper">
        {failedPreview !== current.id ?
          <img alt={current.fileName + ", revision " + current.label} onError={() => setFailedPreview(current.id)}
            src={url + (current.mimeType === "application/pdf" ? "?thumbnail=1" : "")}/>
          : <div className="dp-empty"><p>Preview unavailable</p><a href={url} target="_blank" rel="noreferrer">Open original file</a></div>}
        <a href={url} className="dp-expand" aria-label="Open original drawing in a new tab" title="Open original drawing" target="_blank" rel="noreferrer"><DrawingIcon name="expand" size={14}/></a>
      </div>
      <div className="dp-file">
        <div className="dp-fileicon"><DrawingIcon name="file" size={19}/></div>
        <div className="dp-filename"><strong title={current.fileName}>{current.fileName}</strong><small>{current.mimeType === "application/pdf" ? "PDF drawing" : current.mimeType.slice(6).toUpperCase() + " image"} <span>·</span> {fileSize(current.size)}</small></div>
        <span className="dp-revision">Rev {current.label}</span>
      </div>
      <div className="dp-foot">
        <button type="button" aria-expanded={historyOpen} className="dp-history-button" onClick={() => setHistoryOpen(!historyOpen)}><DrawingIcon name="history" size={14}/> Files &amp; revisions <Icon name="down" size={13}/></button>
        {dirty ? <span className="dp-muted">Save edits to review</span> :
          <Link href={`/quotes/${encodeURIComponent(quoteId!)}/review/${encodeURIComponent(current.id)}`} className="dp-review"><DrawingIcon name="review" size={15}/> Review drawing</Link>}
      </div>
      {historyOpen && <div className="dp-history">
        {data.attachments.map(a => <div key={a.id} className="dp-group"><strong>{a.name}</strong>{a.revisions.map(r =>
          <button type="button" key={r.id} className={r.id === viewId ? "dp-rev-row viewed" : "dp-rev-row"} onClick={() => setViewId(r.id)} aria-pressed={r.id === viewId}>
            <span>Rev {r.label}</span><span>{r.fileName}</span>{r.id === data.selectedRevisionId && <small>Used by quote</small>}
          </button>)}</div>)}
        {!inUse && <button type="button" className="dp-use" disabled={selecting} onClick={async () => {
          setSelecting(true);
          try { await saveRequest({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revisionId: current.id }) }); }
          catch (err) { setError(err instanceof Error ? err.message : "Could not select revision."); }
          finally { setSelecting(false); }
        }}>{selecting ? <Activity>Updating revision</Activity> : "Use this revision for quote"}</button>}
      </div>}
      {!inUse && !historyOpen && <div className="dp-selection-note">Previewing an earlier or alternate file. Open Files &amp; revisions to change the quote selection.</div>}
    </> : <div className="dp-empty">
      <DrawingIcon name="file" size={30}/>
      <p>{loading ? <Activity>Opening drawings</Activity> : !quoteId ? "Save this quote to add a drawing." : error ? "Could not open drawings." : "Have a drawing or photo for this job?"}</p>
      {quoteId && !loading && (error ? <button type="button" onClick={() => setNonce(n => n + 1)}>Try again</button> : <button type="button" onClick={() => setUploadOpen(true)}>Add drawing</button>)}
    </div>}
    {error && <p role="alert" className="dp-error">{error}</p>}
    {uploadOpen && <UploadDialog data={data} onClose={() => setUploadOpen(false)} onUpload={form => saveRequest({ method: "POST", body: form })}/>}
  </section>;
}
