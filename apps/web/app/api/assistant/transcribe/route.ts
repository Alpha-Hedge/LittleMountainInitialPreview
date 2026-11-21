import { quoteResponse } from "../../quotes/_http";
import { QuoteError } from "@/lib/quotes";
import { checkDeskOrigin } from "../_http";

export const runtime = "nodejs";
const formats: Record<string,string> = {"audio/webm":"webm","audio/mp4":"mp4","audio/ogg":"ogg","audio/wav":"wav"};
const limit = 8*1024*1024;

export async function POST(request: Request) {
  return quoteResponse(async () => {
    checkDeskOrigin(request);
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new QuoteError("Voice needs the server's transcription connection. You can type your instruction here.",503);
    const type = (request.headers.get("content-type") || "").split(";")[0];
    if (!Object.hasOwn(formats,type) || !request.body) throw new QuoteError("Use the microphone to record a short instruction.",422);
    const stream = request.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await stream.cancel();
        throw new QuoteError("Record a shorter instruction.",413);
      }
      chunks.push(Buffer.from(value));
    }
    if (!bytes) throw new QuoteError("No audio was recorded.",422);
    const form = new FormData();
    form.set("model",process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-transcribe");
    form.set("file",new Blob(chunks.map(c=>new Uint8Array(c)),{type}),"shop-note."+formats[type]);
    form.set("prompt","Metal fabrication shop instruction. Keep imperial fractions, millimeters, stock numbers and weld terms as spoken.");
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/audio/transcriptions",{
        method:"POST", body:form, headers:{Authorization:"Bearer "+key},
        redirect:"error", signal:AbortSignal.timeout(45000),
      });
    } catch { throw new QuoteError("Transcription could not be reached. Type the instruction or try again.",503); }
    if (!response.ok) throw new QuoteError("The recording could not be transcribed. Type the instruction or try a shorter recording.",502);
    const data = await response.json();
    if (typeof data.text!=="string" || !data.text.trim()) throw new QuoteError("Could not hear an instruction in that recording.",422);
    return { text:data.text.trim().slice(0,2000) };
  });
}
