import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { workspaceRoot } from "./workspace-root";
import { engineeringConnection } from "./engineering-connection";

type Engine = "packages.costing.bridge" | "packages.costing.routing" | "packages.ai.validate" | "packages.cad.bridge";

function runtime(usesNativeLibraries: boolean) {
  const root = workspaceRoot();
  const executable = process.env.NFIP_PYTHON || path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  // The math and CAD kernels only receive the supplied JSON. Keep API and database credentials out of child processes.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "HOME", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const options = { cwd: root, env, windowsHide: true, timeout: 90_000, maxBuffer: 64 * 1024 * 1024 };
  const config = path.join(root, ".nfip-runtime.json");
  if (process.platform === "win32" && !process.env.NFIP_PYTHON && existsSync(config) && (usesNativeLibraries || !existsSync(executable))) {
    const { distro, interpreter } = JSON.parse(readFileSync(config, "utf8").replace(/^\uFEFF/, ""));
    return { executable: "wsl.exe", prefix: ["-d", distro, "--cd", root, "--exec", interpreter], options };
  }
  if (!existsSync(executable)) throw new Error("Install the engineering runtime using the Phase 1 setup commands.");
  return { executable, prefix: [] as string[], options };
}

export class EngineeringInputError extends Error {}

function failure(code: number | string | null | undefined, stderr: string): Error {
  return code === 2 ? new EngineeringInputError(stderr.trim().slice(0, 500) || "Check the engineering inputs.")
    : new Error("The engineering runtime could not complete the request. Verify the Python installation and retry.");
}

export function runPricing<T>(request: unknown): T {
  const { executable, prefix, options } = runtime(false);
  const result = spawnSync(executable, [...prefix, "-S", "-m", "packages.costing.bridge"], {
    ...options, encoding: "utf8", input: JSON.stringify(request),
  });
  if (result.error || result.status !== 0) throw failure(result.status, result.stderr ?? "");
  return JSON.parse(result.stdout) as T;
}

export async function runPython<T>(module: Engine, request: unknown): Promise<T> {
  const route = module === "packages.cad.bridge" ? "sketch" : module === "packages.costing.routing" ? "routing" : null;
  const config = route ? engineeringConnection() : null;
  if (config) {
    let response: Response | undefined;
    try {
      response = await fetch(config.origin + "/v1/desk/" + route, { method: "POST", redirect: "error", cache: "no-store",
        headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(60_000) });
    } catch { /* Pure calculations can run on the workstation during an outage. */ }
    if (response?.ok) return await response.json() as T;
    if (response?.status === 422 || response?.status === 400) {
      const error = await response.json().catch(() => ({}));
      throw new EngineeringInputError(typeof error.detail === "string" ? error.detail.slice(0,500) : "Check the dimensions, units and operation inputs.");
    }
    if (response && response.status < 500) throw new Error("The engineering API rejected this request. Check the service configuration.");
  }
  const run = ({executable, prefix, options}: ReturnType<typeof runtime>) =>
    new Promise<T>((resolve, reject) => {
      const child = execFile(executable, [...prefix, "-m", module], { ...options, encoding: "utf8" }, (err, output, stderr) => {
        if (err) return reject(failure(err.code, stderr));
        try { resolve(JSON.parse(output) as T); }
        catch { reject(new Error("The engineering runtime returned an unreadable result.")); }
      });
      child.stdin?.on("error", () => { /* Process completion supplies the error to the caller. */ });
      child.stdin?.end(JSON.stringify(request));
    });
  // Schema validation uses Pydantic and can use the workstation venv without waking WSL.
  const location = runtime(module !== "packages.ai.validate");
  try {
    return await run(location);
  } catch (error) {
    if (module !== "packages.ai.validate" || error instanceof EngineeringInputError || process.platform !== "win32") throw error;
    const alternate = runtime(true);
    if (alternate.executable === location.executable) throw error;
    return run(alternate);
  }
}
