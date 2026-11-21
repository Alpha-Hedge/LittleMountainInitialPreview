export async function sketchRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : "The sketch desk could not complete that. Try again.";
    throw new Error(message);
  }
  return body;
}
