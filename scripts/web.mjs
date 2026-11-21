import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Next uses its project directory as cwd. The two desks share the original
// workspace's files but can each select a separate SQLite database.
const root = fileURLToPath(new URL("../", import.meta.url));
const web = path.join(root, "apps", "web");
const envFile = path.join(root, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.LMM_WORKSPACE_ROOT = root;
process.chdir(web);

const require = createRequire(path.join(web, "package.json"));
process.argv[1] = require.resolve("next/dist/bin/next");
require(process.argv[1]);
