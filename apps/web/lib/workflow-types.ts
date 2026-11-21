import type { Quote } from "./types";
import type { DrawingRevision } from "./drawing-types";
import type { ReviewRun } from "./review-types";

export type QuoteStatus = "draft" | "awaiting_review" | "approved" | "sent" | "accepted" | "declined" | "expired";
export const statusLabels: Record<QuoteStatus,string> = {
  draft:"Draft", awaiting_review:"Awaiting review", approved:"Approved", sent:"Sent",
  accepted:"Accepted", declined:"Declined", expired:"Expired",
};
export const pricingDecisionLabels = {
  standard: "Standard pricing",
  one_time: "One-time discount or exception",
  recurring: "Recurring pricing preference",
  scope_change: "Change in scope",
} as const;
export interface PricingDecision {
  kind: keyof typeof pricingDecisionLabels;
  reason: string;
}
export interface ReviewDetails {
  pricingDecision?: PricingDecision;
  scope:string; leadTime:string; terms:string; expiresOn:string; assumptions:string;
  resolutions:Record<string,string>; lineDescriptions:Record<string,string>;
  scopeConfirmed:boolean; leadTimeConfirmed:boolean;
}
export interface ReviewSnapshot {
  quote:Quote; drawing:DrawingRevision|null; reviewRuns:ReviewRun[]; details:ReviewDetails;
  questions:{id:string; label:string}[];
}
export interface ApprovalSnapshot extends ReviewSnapshot { approvedAt:string; approvedBy:string }
export interface CustomerQuote {
  customer:string; jobName:string; quoteNumber:string; version:number; scope:string; leadTime:string;
  terms:string; expiresOn:string; issuedOn:string;
  lines:{description:string;quantity:number;sellingPrice:number}[]; sellingPrice:number;
}
export interface QuoteReviewView {
  startingPrice:{version:number;sellingPrice:number;marginPercent:number};
  pricingReasonRequired:boolean;
  snapshot:ReviewSnapshot; status:QuoteStatus; currentVersion:number; approvedAt:string|null;
  customer:CustomerQuote; events:{at:string;message:string;version:number}[];
  versions:{version:number;status:QuoteStatus}[];
}
