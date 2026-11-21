import path from "node:path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  distDir: process.env.LMM_DIST_DIR || ".next",
  devIndicators: false,
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "pdfkit", "heic-convert"],
};
export default nextConfig;
