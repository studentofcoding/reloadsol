#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const files = execSync('grep -rl "<img" src --include="*.tsx"', {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const importLine =
  'import { OptimizedImage } from "@/components/OptimizedImage";';

for (const rel of files) {
  const file = path.join(root, rel);
  let content = fs.readFileSync(file, "utf8");
  if (!content.includes("<img")) continue;

  if (!content.includes("OptimizedImage")) {
    if (content.startsWith('"use client"') || content.startsWith("'use client'")) {
      const firstLineEnd = content.indexOf("\n") + 1;
      content =
        content.slice(0, firstLineEnd) +
        "\n" +
        importLine +
        content.slice(firstLineEnd);
    } else {
      content = importLine + "\n" + content;
    }
  }

  content = content.replace(/<img\b/g, "<OptimizedImage");
  fs.writeFileSync(file, content);
  console.log("Updated", rel);
}
