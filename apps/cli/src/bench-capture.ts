#!/usr/bin/env bun
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { captureEvidence } from "./bench-evidence";

const { values } = parseArgs({
  options: { out: { type: "string" } },
  strict: true,
});
if (!values.out)
  throw new Error(
    "Usage: bun run bench:capture --out var/bench/<night>/<new-capture-dir>"
  );
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => abort.abort());
try {
  const result = await captureEvidence({
    directory: resolve(values.out),
    baseUrl: process.env["ROBO_URL"] ?? "http://127.0.0.1:8940",
    ...(process.env["ROBO_TOKEN"] ? { token: process.env["ROBO_TOKEN"] } : {}),
    signal: abort.signal,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Capture failed");
  process.exitCode = 1;
}
