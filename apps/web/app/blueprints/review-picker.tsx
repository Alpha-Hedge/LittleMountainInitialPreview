"use client";

export interface ReviewChoice { id: string; label: string }

export function ReviewPicker({label, choices, selected, choose}: {
  label: string; choices: ReviewChoice[]; selected: string; choose: (id: string) => void;
}) {
  const index = Math.max(0, choices.findIndex(choice => choice.id === selected));
  if (!choices.length) return null;
  return <nav className="bp-picker" aria-label={label + " navigation"}>
    <div className="bp-picker-label"><span>{label}</span>{choices.length > 1 && <small aria-live="polite">{index+1} of {choices.length}</small>}</div>
    <select aria-label={label} value={choices[index].id} onChange={e => choose(e.target.value)}>
      {choices.map(choice => <option value={choice.id} key={choice.id}>{choice.label}</option>)}
    </select>
    {choices.length > 1 && <div className="bp-pager">
      <button type="button" aria-label={"Previous " + label.toLowerCase()} disabled={!index} onClick={() => choose(choices[index-1].id)}>←</button>
      <button type="button" aria-label={"Next " + label.toLowerCase()} disabled={index+1 === choices.length} onClick={() => choose(choices[index+1].id)}>→</button>
    </div>}
  </nav>;
}
