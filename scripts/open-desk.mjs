import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = "http://127.0.0.1:3100/";
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
process.chdir(root);
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

async function deskIsOpen() {
  let html;
  try {
    const response = await fetch(home, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return false;
    html = await response.text();
  } catch {
    return false;
  }
  if (!html.includes("Little Mountain Metalworks")) {
    throw Error(
      "Another program is using the quote desk’s address. Ask the person who set up this computer for help.",
    );
  }
  return true;
}

function startHidden(command, args) {
  const child = spawn(command, args, { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child;
}

async function startDrawingReader() {
  if (process.platform !== "win32" || (process.env.VISION_PROVIDER || "llama.cpp") !== "llama.cpp")
    return;
  const url = (process.env.VISION_BASE_URL || "http://127.0.0.1:8187/v1").replace(/\/$/, "");
  if (url !== "http://127.0.0.1:8187/v1") return;
  if (
    ![
      "linux/llama-server",
      "Qwen3-VL-2B-Instruct-Q8_0.gguf",
      "mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf",
    ].every((file) => existsSync(path.join(root, ".local-vision", file)))
  )
    return;
  try {
    await fetch("http://127.0.0.1:8187/health", { signal: AbortSignal.timeout(1000) });
  } catch {
    startHidden("wsl.exe", [
      "-d",
      "Ubuntu-24.04",
      "--",
      "flock",
      "-n",
      "/tmp/lmm-drawing-reader.lock",
      "bash",
      "scripts/start-vision.sh",
    ]);
  }
}

try {
  if (!(await deskIsOpen())) {
    let next;
    try {
      require.resolve("next/package.json");
      next = path.join(root, "scripts", "web.mjs");
    } catch {
      throw Error(
        "This computer needs the one-time setup in BUILD_STATUS.md before it can open the quote desk.",
      );
    }
    if (!existsSync(path.join(root, "apps", "web", ".next", "BUILD_ID"))) {
      console.log("Getting the desk ready for the first time…");
      const build = spawnSync(process.execPath, [next, "build"], {
        cwd: root,
        windowsHide: true,
        stdio: "inherit",
      });
      if (build.status !== 0)
        throw Error("Setup could not finish. The job files are still on this computer.");
    }
    const server = startHidden(process.execPath, [
      next,
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3100",
    ]);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await delay(400);
      if (await deskIsOpen()) {
        ready = true;
        break;
      }
      if (server.exitCode !== null) break;
    }
    if (!ready)
      throw Error(
        "The quote desk could not open. Try again or ask the person who set up this computer.",
      );
  }
  await startDrawingReader();
  if (!process.argv.includes("--check")) {
    startHidden("explorer.exe", [home]);
  }
  console.log("The quote desk is ready at " + home);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
