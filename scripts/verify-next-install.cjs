#!/usr/bin/env node

const path = require("node:path");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveFromProject(specifier) {
  return require.resolve(specifier, { paths: [process.cwd()] });
}

try {
  const nextBinPath = resolveFromProject("next/dist/bin/next");
  const logModulePath = resolveFromProject("next/dist/build/output/log");

  if (!path.isAbsolute(nextBinPath) || !path.isAbsolute(logModulePath)) {
    fail("Next.js install check failed: resolved paths were not absolute.");
  }
} catch (error) {
  const details =
    error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "Unknown error";

  fail(
    [
      "Corrupted Next.js installation detected.",
      "The required module `next/dist/build/output/log` is missing or unreadable.",
      "",
      "Recommended fix:",
      "1. rm -rf node_modules package-lock.json",
      "2. npm install",
      "",
      `Details: ${details}`,
    ].join("\n"),
  );
}

