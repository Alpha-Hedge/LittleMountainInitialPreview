import { QuoteError } from "@/lib/quotes";

export function checkDeskOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === new URL(request.url).origin) return;
  const host = request.headers.get("host");
  if (host && ["http://"+host, "https://"+host].includes(origin)) return;
  throw new QuoteError("Open the shop desk before using its assistant.",403);
}
