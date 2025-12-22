import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const templatePaths = ["src/server.ts", "src/render/home.ts"].map((path) => resolve(path));
const scriptMatches = templatePaths
  .filter((path) => existsSync(path))
  .flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/gi)];
  });

if (scriptMatches.length === 0) {
  console.error("No <script> blocks found in template files.");
  process.exit(1);
}

let hasErrors = false;
const tmpRoot = mkdtempSync(join(tmpdir(), "todo-inline-js-"));

scriptMatches.forEach((match, index) => {
  const script = match[1];
  const sanitized = script
    .replace(/(?<!\\)\$\{[^}]*\}/g, "0")
    .replace(/\\`/g, "`")
    .replace(/\\\$/g, "$");
  const tmpFile = join(tmpRoot, `inline-${index + 1}.mjs`);
  writeFileSync(tmpFile, sanitized, "utf8");

  try {
    execSync(`node --check ${tmpFile}`, { stdio: "pipe" });
  } catch (error) {
    hasErrors = true;
    const message =
      error && typeof error === "object" && "stderr" in error && error.stderr
        ? error.stderr.toString()
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`Inline script #${index + 1} failed to parse:\n${message}`);
  }
});

if (hasErrors) {
  process.exit(1);
}
