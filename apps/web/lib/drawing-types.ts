export const maxDrawingBytes = 20 * 1024 * 1024;
export type DrawingMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp";

export interface DrawingRevision {
  id: string;
  attachmentId: string;
  label: string;
  fileName: string;
  mimeType: DrawingMime;
  size: number;
  createdAt: string;
  hasThumbnail: boolean;
}

export interface DrawingAttachment {
  id: string;
  name: string;
  revisions: DrawingRevision[];
}

export interface DrawingState {
  attachments: DrawingAttachment[];
  selectedRevisionId: string | null;
}
