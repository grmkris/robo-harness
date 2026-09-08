import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

// Expect currently hardcodes one daemon state file for all projects. Redirect
// only that file for this check, including in the spawned daemon, so another
// project's navigation cannot change the browser under an acceptance script.
const sessionPath = process.env.ROBO_EXPECT_SESSION;
if (sessionPath) {
  for (const name of ["readFileSync", "writeFileSync", "unlinkSync"]) {
    const original = fs[name];
    fs[name] = (path, ...args) =>
      original(
        path === "/tmp/expect-cli-session.json" ? sessionPath : path,
        ...args
      );
  }
  syncBuiltinESMExports();
}

// Keep deterministic Expect CLI checks local; disable unrelated external
// update requests made by the command-line wrapper.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  );
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    return Promise.reject(
      new Error("External CLI fetch disabled for local validation")
    );
  }
  return nativeFetch(input, init);
};
