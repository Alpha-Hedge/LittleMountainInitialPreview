import { DrawingError } from "./drawings";
import { maxDrawingBytes } from "./drawing-types";

export async function readDrawingUpload(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data") || !request.body) {
    throw new DrawingError("Choose a drawing file.");
  }
  const limit = maxDrawingBytes + 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) {
    throw new DrawingError("The drawing exceeds 20 MB.", 413);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new DrawingError("The drawing exceeds 20 MB.", 413);
    }
    chunks.push(value);
  }
  try {
    return await new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new DrawingError("The upload could not be read.");
  }
}
