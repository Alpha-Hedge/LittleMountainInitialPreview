"use client";
import { useState, type ReactNode } from "react";

export default function ShopSettingsSections({ pricing, rules, history }: {
  pricing: ReactNode; rules?: ReactNode; history: ReactNode;
}) {
  const [section, setSection] = useState("pricing");
  const sections = [
    { id: "pricing", label: "Shop pricing", content: pricing },
    ...(rules ? [{ id: "rules", label: "Estimating rules", content: rules }] : []),
    { id: "history", label: "History & connections", content: history },
  ];
  return <>
    <div className="workspace-views" role="group" aria-label="Settings sections">
      {sections.map(item => <button type="button" key={item.id} aria-controls={"settings-" + item.id}
        aria-pressed={section === item.id} onClick={() => setSection(item.id)}>{item.label}</button>)}
    </div>
    {sections.map(item => <div key={item.id} id={"settings-" + item.id} className="settings-section"
      hidden={section !== item.id}>{item.content}</div>)}
  </>;
}
