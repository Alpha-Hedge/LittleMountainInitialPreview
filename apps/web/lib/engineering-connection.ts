import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { workspaceRoot } from "./workspace-root";

export function engineeringConnection() {
  const root = workspaceRoot();
  if (path.resolve(root, process.env.LMM_DATA_DIR || "data") !== path.resolve(root, process.env.NFIP_ARCHIVE_DATA_DIR || "data")) return null;
  const file = path.resolve(root, process.env.NFIP_ARCHIVE_ENV || ".env.nfip");
  const settings = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const endpoint = process.env.NFIP_INTERNAL_API_URL ?? process.env.NFIP_API_URL ?? settings.NFIP_API_URL;
  const token = process.env.NFIP_API_TOKEN ?? settings.NFIP_API_TOKEN;
  if (!endpoint || !token) return null;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)))
    throw new Error("Use a local engineering API or HTTPS.");
  return { origin:url.origin, token };
}

