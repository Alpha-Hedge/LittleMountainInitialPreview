"use client";
import { useId, useState } from "react";
import { Icon } from "./Icons";

export default function DrawingFilePicker({ label, accept, formats, name, fileName, onSelect, required = false }: {
  label: string; accept: string; formats: string; name?: string; fileName: string;
  onSelect: (file: File | null) => void; required?: boolean;
}) {
  const hint = useId();
  const [dragging, setDragging] = useState(false);
  return <label className="upload-zone" data-dragging={dragging}
    onDragOver={() => setDragging(true)} onDragLeave={() => setDragging(false)} onDrop={() => setDragging(false)}>
    <span className="upload-symbol"><Icon name={fileName ? "quotes" : "upload"} size={24}/></span>
    <strong>{fileName || "Choose a file or drop it here"}</strong>
    <span id={hint}>{fileName ? "Choose another file" : formats + " · Up to 20 MB"}</span>
    <input type="file" name={name} accept={accept} required={required} aria-label={label} aria-describedby={hint}
      onChange={event => onSelect(event.currentTarget.files?.[0] ?? null)} />
  </label>;
}
