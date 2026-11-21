export type AssistantKind = "quote" | "blueprint" | "sketch";
export type AssistantTurn = { role: "operator" | "assistant"; text: string };
export type AssistantChange = { label: string; before: string; after: string; evidence?: string };
export type AssistantReply<T> = {
  answer: string;
  changes: AssistantChange[];
  draft: T | null;
  changedPaths: string[];
  checks: string[];
  checkedBy?: string;
  estimatedCost?: number;
  sellingPrice?: number;
};
