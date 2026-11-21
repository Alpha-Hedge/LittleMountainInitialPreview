export function isHostedPreview() {
  return process.env.VERCEL_ENV === "production" || process.env.VERCEL_ENV === "preview";
}
