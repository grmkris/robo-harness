import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    // Runtime state, build output and virtual environments are not source.
    "var/**",
    "dist/**",
    "apps/web/dist/**",
    ".venv/**",
    ".expect/**",
    // The URDF is a vendored lab artifact; its formatting belongs upstream.
    "assets/**",
    // Written by agent platforms and tracked as generated.
    ".claude/**",
    ".codex/**",
    ".grok/**",
  ],
});
