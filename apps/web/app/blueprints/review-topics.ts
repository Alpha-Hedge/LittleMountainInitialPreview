import type { BlueprintJob } from "@/lib/blueprint-types";

type ReviewFlag = BlueprintJob["flags"][number];
export type ReviewPanel = "setup" | "check";
export type ReviewTab = ReviewPanel | "inventory";
export type OpenCheck = (panel: ReviewPanel, id: string) => void;

export function reviewTopic(flag: ReviewFlag) {
  if (flag.kind === "unsupported" && /\.(stock_form|field_weld)$/.test(flag.path)) return "pricing";
  if (flag.kind === "unverified_source" || /^(Coverage check|Printed source callouts)/.test(flag.reason)) return "source";
  return "specs";
}

export function partIndex(path: string) {
  return /^parts\.(\d+)(?:\.|$)/.exec(path)?.[1];
}

export function openReviewSection(id: string) {
  const target = document.getElementById(id);
  let panel = target?.closest("details[data-review-section], details[data-review-lane]");
  while (panel instanceof HTMLDetailsElement) {
    panel.open = true;
    panel = panel.parentElement?.closest("details[data-review-section], details[data-review-lane]");
  }
  target?.querySelector<HTMLElement>("summary")?.focus({preventScroll:true});
  target?.scrollIntoView({block:"nearest"});
}
