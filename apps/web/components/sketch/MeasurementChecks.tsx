import type { ReactNode } from "react";
import type { Mark, PhotoReading, Pin } from "@/lib/sketch/conversion-types";
import { Icon } from "../Icons";
import { fieldNames, targetName } from "./ReadingFields";

function guidance(pin: Pin, mark?: Mark) {
  const field = pin.field && fieldNames[pin.field];
  if (field) return {
    title: pin.field === "quantity" ? "How many pieces are needed?" : "Enter the " + field.toLowerCase(),
    help: pin.field === "quantity" ? "Use the quantity ordered for this part." :
      pin.field === "material" ? "Enter the stock or grade specified for this part." :
      "Use the written callout or a confirmed shop measurement. Leave it open if the size is unknown.",
  };
  if (pin.code === "engineering_note") return {title:"Confirm the engineering reference", help:"Record the reviewer or approved reference in the review note before confirming this item."};
  if (pin.code === "tentative_thickness") return {title:"Which thickness is final?", help:"Compare the stated thickness with the approved value. Update the part if it changed."};
  if (pin.code === "low_confidence") return {title:mark ? "Verify the " + fieldNames[mark.kind].toLowerCase() : "Check the marked feature", help:"Find the marked spot on the photo. Compare it with the reading below and correct any difference in the part details."};
  if (pin.code === "unbound") return {title:"What does this mark represent?", help:"If it is a cut feature, add it to the part. If it is a note or stray line, identify it below."};
  if (pin.code === "topology") return {title:"Identify the outline to cut",help:"Check the flat view of this part. Edit its shape and corners in the part details."};
  if (pin.code === "clarify") return {title:"Clarify the sketch",help:"Use the question below to check the original. Record the answer in the drawing details or review note."};
  if (pin.code === "conflict") return {title:"Resolve the conflicting measurements",help:"Compare the written callouts and enter the confirmed measurement in the part details."};
  if (pin.code === "source_comparison") return {title:"Compare the drawing with the sketch",help:"Use the source note below to find the difference and correct the reading if needed."};
  return {title:mark ? "Review the " + fieldNames[mark.kind].toLowerCase() : "Check the drawing detail",help:"Read the source note below and update the matching detail before saving."};
}

type Props = {
  canSave: boolean; pins: Pin[]; reading: PhotoReading; original: PhotoReading; partFilter: string;
  setFilter: (part: string) => void; selected: number; select: (index: number) => void;
  showPhoto: (pin: Pin) => void; markers: boolean; toggleMarkers: () => void;
  control: (pin: Pin, index: number) => ReactNode; answered: (pin: Pin, index: number) => boolean;
};

export default function MeasurementChecks({canSave,pins,reading,original,partFilter,setFilter,selected,select,showPhoto,markers,toggleMarkers,control,answered}: Props) {
  const parts = [...new Set(pins.map(pin => pin.part_id || ""))];
  const name = (id: string | null) => reading.parts.find(part => part.part_id === id)?.name || id || "Whole drawing";
  const indices = pins.map((_,i) => i).filter(i => partFilter === "*" || (pins[i].part_id || "") === partFilter);
  const index = indices.includes(selected) ? selected : indices[0];
  const pin = pins[index];
  if (!pin) return null;
  const part = original.parts.find(part => part.part_id === pin.part_id);
  const mark = pin.annotation != null ? part?.annotations[pin.annotation] : undefined;
  const {title,help} = guidance(pin,mark);
  const position = indices.indexOf(index);
  const source = mark?.evidence?.trim();
  const thicknesses = [...new Set(part?.annotations.filter(a=>a.kind==="thickness" && a.targets.includes(pin.target)).map(a=>a.value.trim()) ?? [])];
  const value = pin.code === "tentative_thickness" && thicknesses.length === 1 ? thicknesses[0] : mark?.value?.trim();
  const comparable = (text?: string) => text?.trim().replace(/^\((.*)\)$/,"$1").replace(/\s+/g," ").toLowerCase();
  const showSource = !!source && comparable(source)!==comparable(value);
  const showReason = !pin.field && (!source || !["tentative_thickness","engineering_note","low_confidence","topology"].includes(pin.code)) && comparable(pin.message)!==comparable(source);
  const editor = control(pin,index);
  const openEditor = () => {
    const group = document.getElementById(pin.part_id ? "reading-part-" + pin.part_id : "sketch-drawing-details");
    if (group instanceof HTMLDetailsElement) group.open = true;
    const editedPart = reading.parts.find(part=>part.part_id===pin.part_id);
    const fieldIndex = pin.code==="tentative_thickness" ? editedPart?.annotations.findIndex(a=>a.kind==="thickness" && a.targets.includes(pin.target)) : pin.annotation;
    const field = fieldIndex != null && fieldIndex>=0 ? document.getElementById("mark-"+pin.part_id+"-"+fieldIndex) : null;
    const target = field || group;
    target?.scrollIntoView({block:"center"});
    target?.querySelector<HTMLElement>("summary,input,select")?.focus({preventScroll:true});
  };
  return <section className="panel sk-card ph-checks guided-checks" aria-label="Measurement checks">
    <header><h2>Details to check ({pins.length})</h2>
      <p>Compare each item with the sketch. You can skip an unknown and come back to it before releasing cut files.</p></header>
    <div className="check-filters">
      {parts.length > 1 && <label>Show checks for<select value={partFilter} onChange={e=>setFilter(e.target.value)}>
        <option value="*">All parts</option>{parts.map(id=><option key={id} value={id}>{name(id)}</option>)}
      </select></label>}
      <label>Jump to a check<select value={index} onChange={e=>select(Number(e.target.value))}>
        {indices.map(i=><option key={i} value={i}>{answered(pins[i],i) ? "✓ " : ""}{i+1}. {name(pins[i].part_id)} · {pins[i].field ? fieldNames[pins[i].field!] : guidance(pins[i]).title}</option>)}
      </select></label>
    </div>
    <article className="check-focus" id={"pin-"+index} tabIndex={-1} key={index}>
      <div className="check-context"><span>{name(pin.part_id)}{pin.target !== "P" && pin.target !== "drawing" ? " · "+targetName(pin.target) : ""}</span>
        <button type="button" className="ph-link" onClick={()=>showPhoto(pin)}><Icon name="search" size={14}/>View on photo</button></div>
      <h3>{title}</h3><p>{help}</p>
      {(showReason || showSource || value) && <div className="check-evidence">
        {value && <p><b>{pin.code==="tentative_thickness" ? "Thickness on sketch" : "AI reading"}</b> {value}</p>}
        {showSource && <p><b>Source note</b> {source}</p>}
        {showReason && <p><b>{pin.code === "clarify" ? "Question" : "Why it’s open"}</b> {pin.message}</p>}
      </div>}
      {editor}
      {(!editor || pin.review_key || pin.code==="clarify" || pin.code==="unbound") && <button type="button" className="ph-link check-edit" onClick={openEditor}>Open {pin.part_id ? "part" : "drawing"} details <Icon name="arrow" size={14}/></button>}
    </article>
    <div className="check-stepper"><button type="button" disabled={!position} onClick={()=>select(indices[position-1])}>Previous</button>
      <span aria-live="polite">Check {position+1} of {indices.length}</span>
      <button type="button" disabled={position===indices.length-1} onClick={()=>select(indices[position+1])}>Next check <Icon name="arrow" size={14}/></button></div>
    {answered(pin,index) && <p role="status" className="check-recorded"><Icon name="check" size={15}/>Answer entered · save and check to update this drawing.</p>}
    <footer><button type="button" className="ph-link" aria-pressed={markers} onClick={toggleMarkers}>{markers ? "Hide check markers" : "Show check markers on photo"}</button>
      {canSave && <a href="#sketch-signoff">Review note &amp; save</a>}</footer>
  </section>;
}
