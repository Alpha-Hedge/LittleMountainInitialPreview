import type { ReactNode } from "react";

function emphasis(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*)/g).map((part,i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2,-2)}</strong> : part);
}

export default function AssistantMessage({text}: {text:string}) {
  const blocks: ReactNode[] = [];
  let lines: string[] = [], mode: "p"|"ol"|"ul" = "p", start = 1;
  function flush() {
    if (!lines.length) return;
    const key = blocks.length;
    const items = lines.map((line,i)=><li key={i}>{emphasis(line)}</li>);
    blocks.push(mode === "p" ? <p key={key}>{emphasis(lines.join("\n"))}</p>
      : mode === "ol" ? <ol key={key} start={start}>{items}</ol> : <ul key={key}>{items}</ul>);
    lines = [];
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.+)$/.exec(line);
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {flush(); blocks.push(<p key={blocks.length}><strong>{emphasis(heading[1])}</strong></p>);continue;}
    const next = bullet ? bullet[1] ? "ol" : "ul" : "p";
    if (next !== mode) flush();
    mode = next;
    if (!lines.length && bullet?.[1]) start = Number(bullet[1]);
    lines.push(bullet ? bullet[2] : line.trim());
  }
  flush();
  return <div className="chat-answer">{blocks}</div>;
}
