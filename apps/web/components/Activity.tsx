import type { ReactNode } from "react";

export default function Activity({children, done = false}: {children: ReactNode; done?: boolean}) {
  return <span className="work-activity" data-done={done || undefined}>
    {done ? <svg className="activity-check" aria-hidden="true" viewBox="0 0 16 16"><path d="m3 8 3 3 7-7"/></svg> :
      <span className="activity-spinner" aria-hidden="true"/>}{children}
  </span>;
}
