#!/usr/bin/env node
/**
 * Enforces: never hardcode a SOL (or native) price.
 *
 * A literal price is indistinguishable from a real one to everything downstream, so it silently
 * converts USD at a rate that is not the market's — a displayed estimate, a recorded PnL, or a sim
 * writer all treat it as fact. The app has exactly one source of truth, read live:
 *   - server: `getSolPriceUSDCore()` (src/utils/sol-price-core.ts), which reports
 *     `price: 0, source: 'unavailable'` when no source has produced a price
 *   - client: `useSolPrice()` (src/hooks/useSolPrice.ts) over `/api/solprice`
 * When the price is unknown, callers skip or show an explicit placeholder — they never assume.
 *
 * Test files are exempt: a fixture price is an input, not a shipped conversion.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");
const EXT = new Set([".ts", ".tsx"]);

const issues = [];

function isTestFile(name) {
  return /\.(test|spec)\.tsx?$/.test(name);
}

function scanFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const lines = fs.readFileSync(filePath, "utf8").split("\n");

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const add = (rule, message) => issues.push({ file: rel, line: lineNo, rule, message });

    // A literal beside a price/native/SOL expression — the retired `145` sentinel class.
    if (/\b\d{2,4}(\.\d+)?\b/.test(line) && /\b(sol|native|eth|price|usd)\b/i.test(line)) {
      // `Chrome/145` UA strings and similar version numbers are not prices.
      const looksLikeVersion = /(chrome|safari|version|v)\s*[/"]?\s*\d/i.test(line);
      if (!looksLikeVersion) {
        // Only flag when the literal actually feeds a price-shaped target.
        if (
          /(solPrice|nativePrice|ethPrice|PriceUsd|priceUsd|nativeUsd|solUsd|SOL_PRICE|DEFAULT_SOL)\w*\s*(=|:|\?\?|\|\|)\s*-?\d/.test(
            line,
          ) ||
          /\bsol\s*\*\s*\d/.test(line) ||
          /\breturn\s+\d{2,4}\s*(;|\/\/)/.test(line)
        ) {
          add(
            "no-hardcoded-sol-price",
            "hardcoded native/SOL price — read it live from getSolPriceUSDCore() or useSolPrice()",
          );
        }
      }
    }

    // The specific retired sentinel, wherever it survives.
    if (/\b145\b/.test(line) && /\b(sol|native|price|usd|DEFAULT)\b/i.test(line)) {
      add("no-hardcoded-sol-price", "the retired 145 SOL-price sentinel — remove it");
    }
  });
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(full);
      continue;
    }
    if (!EXT.has(path.extname(entry.name))) continue;
    if (isTestFile(entry.name)) continue;
    scanFile(full);
  }
}

walk(SRC);

if (issues.length > 0) {
  console.error("verify:no-hardcoded-sol-price — hardcoded native price(s) found:");
  for (const issue of issues) {
    console.error(`  ${issue.file}:${issue.line}  [${issue.rule}] ${issue.message}`);
  }
  process.exit(1);
}

console.log(
  "verify:no-hardcoded-sol-price — no hardcoded SOL/native price (live source only).",
);
