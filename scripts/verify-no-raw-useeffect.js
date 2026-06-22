#!/usr/bin/env node
/**
 * Advisory check for common useEffect anti-patterns.
 * Lint (react-hooks/*) remains the primary gate; this script catches a few
 * patterns that are easy to grep and often cause dev-only effect loops.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const EXT = new Set([".ts", ".tsx"]);

const issues = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full);
      continue;
    }
    const ext = path.extname(entry.name);
    if (!EXT.has(ext)) continue;
    scanFile(full);
  }
}

function scanFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // async useEffect callbacks are invalid and often hide missing error handling
    if (/useEffect\s*\(\s*async\b/.test(line)) {
      issues.push({
        file: rel,
        line: lineNo,
        rule: "no-async-useeffect",
        message: "useEffect must not use an async callback directly",
      });
    }

    // Direct setState(true) loading flags inside useEffect without nearby catch/finally
    if (
      /useEffect\s*\(/.test(line) ||
      (/set(?:Is)?Loading\w*\(\s*true\s*\)/.test(line) &&
        !/catch\s*\(/.test(text.slice(text.indexOf(line), text.indexOf(line) + 800)))
    ) {
      // handled below via block scan
    }
  });

  // Flag loading=true in useEffect bodies that lack try/finally in the same effect
  const effectRegex = /useEffect\s*\(\s*(?:\(\)\s*=>\s*)?\{/g;
  let match;
  while ((match = effectRegex.exec(text)) !== null) {
    const start = match.index;
    const braceStart = text.indexOf("{", start);
    if (braceStart === -1) continue;

    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    const body = text.slice(braceStart, end);
    if (!/set(?:Is)?Loading\w*\(\s*true\s*\)/.test(body)) continue;
    if (/finally\s*\{/.test(body) || /catch\s*\(/.test(body)) continue;

    const lineNo = text.slice(0, start).split("\n").length;
    issues.push({
      file: rel,
      line: lineNo,
      rule: "loading-without-catch",
      message:
        "useEffect sets a loading flag to true but has no try/catch/finally in the effect body",
    });
  }
}

if (fs.existsSync(SRC)) {
  walk(SRC);
}

if (issues.length === 0) {
  console.log(
    "verify:no-raw-useeffect — no blocking patterns found (eslint react-hooks warnings may still apply).",
  );
  process.exit(0);
}

console.error("verify:no-raw-useeffect found potential issues:\n");
for (const issue of issues) {
  console.error(
    `  ${issue.file}:${issue.line} [${issue.rule}] ${issue.message}`,
  );
}
console.error(
  `\n${issues.length} issue(s). Fix async useEffect callbacks; ensure loading flags clear on error.`,
);
process.exit(1);
