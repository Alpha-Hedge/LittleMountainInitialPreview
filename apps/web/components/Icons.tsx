import type { CSSProperties, ReactNode } from 'react';

const shapes: Record<string, ReactNode> = {
  chat: <path d="M20.5 11.5a8.5 8.5 0 0 1-8.5 8.5 10 10 0 0 1-3.4-.7L4 20.5l1.2-4.1a8.5 8.5 0 1 1 15.3-4.9Z"/>,
  send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  mic: <><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5m-3 0h6"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  upload: <><path d="M12 15V3m-4.5 4.5L12 3l4.5 4.5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></>,
  home: <><path d="m3 10 9-7 9 7M5.5 9v11h13V9M10 20v-6h4v6"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 0 1 5.2 1c0 2-2.7 2.4-2.7 4m0 3h.01"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  book: <><path d="M3 5c3-1 6-.5 9 1.5C15 4.5 18 4 21 5v14c-3-1-6-.5-9 1.5C9 18.5 6 18 3 19V5Zm9 1.5v14"/></>,
  filter: <><path d="M3 6h18M6 12h12M9 18h6"/></>,
  inbox: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  jobs: <><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12q9 5 18 0m-9 1v3"/></>,
  settings: <><path d="M3 6h4m4 0h10M3 12h12m4 0h2M3 18h6m4 0h8"/><circle cx="9" cy="6" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="11" cy="18" r="2"/></>,
  quotes: <><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></>,
  sketch: <><path d="M12 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="m10 15 .7-3.3 7.8-7.8a1.5 1.5 0 0 1 2.1 2.1l-7.8 7.8L10 15Zm6.8-9.5 2.1 2.1M8 17h5"/></>,
  blueprint: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8v8h8V8H8Zm0 4h8M12 8v8M5.5 8h.01m0 8h.01m13-8h.01m0 8h.01"/></>,
  drawing: <><path d="M4 18.5h15.5V4L4 18.5Z"/><path d="m14 10.5 1.6 1.6m-5.1 1.8 1.6 1.6"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  down: <path d="m6 9 6 6 6-6"/>,
  save: <><path d="M5 3.5h12l3.5 3.6v12.4a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M8 3.5V9h8V3.5M8 20.5v-7h9v7"/></>,
  items: <><path d="m3 7 9-4 9 4-9 4-9-4Zm0 5 9 4 9-4M3 17l9 4 9-4"/></>,
  details: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h3m-3 4h6m2-4h2"/></>,
  trash: <><path d="M4.5 6.5h15m-13 0L7.5 20h9l1-13.5M9 6.5V4h6v2.5m-5 3.5v6m4-6v6"/></>,
  clock: <><circle cx="12" cy="12" r="8.7"/><path d="M12 7v5l3 2"/></>,
  calculator: <><rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M8 6.5h8v3H8zm.5 7h1m4 0h1m-6 4h1m4 0h1"/></>,
  check: <path d="m4.5 12 5 5 10-11"/>,
  library: <><rect x="3" y="4" width="5" height="16" rx="1"/><path d="M11 4v16m3-15 4-1 3 15-4 1-3-15Z"/></>,
  arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
};

export function Icon({name, size = 18, style, className}: {name: string; size?: number; style?: CSSProperties; className?: string}) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" style={style} className={className}>{shapes[name]}</svg>;
}

export function MountainMark() {
  return <svg aria-hidden="true" width="45" height="42" viewBox="0 0 48 42" fill="none"><path d="M3 32 15.4 12.5l6.1 9.4L30 7l15 25H3Z" stroke="currentColor" strokeWidth="2.7" strokeLinejoin="round"/><path d="m11.1 19.3 4.2 3.1 3.2-5m7.1-2.7 4.1 3.6 3.9-4.8M8 36.5h32" stroke="currentColor" strokeWidth="2.15" strokeLinejoin="round" strokeLinecap="round"/></svg>;
}
