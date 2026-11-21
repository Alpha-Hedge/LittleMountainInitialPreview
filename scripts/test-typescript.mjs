import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import ts from "typescript";

// Run the project's TypeScript domain code inside an isolated Node test process.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !path.extname(specifier)) {
        return next(specifier + ".ts", context);
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const { outputText } = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
