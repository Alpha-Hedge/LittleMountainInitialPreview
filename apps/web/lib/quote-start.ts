import type { LineItem } from "./types";

export const drawingDraftCustomer = "Customer not entered";
export const drawingDraftPart = "New drawing quote";
export const drawingDraftPartId = "drawing-starter";

export function isDrawingDraftPart(item: Pick<LineItem, "id" | "description">) {
  return (
    item.id === drawingDraftPartId && item.description === drawingDraftPart
  );
}
