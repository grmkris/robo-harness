import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";

// The house Oxlint policy: ultracite's core + anti-slop, plus the React preset
// for the workbench. The `transitional` block below downgrades to `warn` the
// rules that fire only on code the Effect migration (Phase 3) rewrites or the
// workbench split rearranges. They stay visible in `lint` and `lint:types` without failing the gate, and
// each is meant to return to `error` as its files are rewritten, then the block
// is deleted. Nothing here silences a rule permanently.
const transitional = {
  complexity: "warn",
  curly: "warn",
  "func-style": "warn",
  "no-await-in-loop": "warn",
  "no-empty": "warn",
  "no-empty-function": "warn",
  "no-nested-ternary": "warn",
  "no-param-reassign": "warn",
  "no-plusplus": "warn",
  "no-shadow": "warn",
  "no-unmodified-loop-condition": "warn",
  "no-use-before-define": "warn",
  "one-var": "warn",
  "prefer-destructuring": "warn",
  "prefer-template": "warn",
  "require-await": "warn",
  "require-unicode-regexp": "warn",
  "anti-slop/no-conditional-empty-object-spread": "warn",
  "anti-slop/no-runtime-typeof": "warn",
  "anti-slop/no-unknown-parameters": "warn",
  "anti-slop/no-unknown-returns": "warn",
  "anti-slop/no-unsafe-dictionary-type": "warn",
  "anti-slop/require-safety-comment-for-type-assertion": "warn",
  "import/consistent-type-specifier-style": "warn",
  "import/newline-after-import": "warn",
  "import/no-mutable-exports": "warn",
  "promise/prefer-await-to-callbacks": "warn",
  "promise/prefer-await-to-then": "warn",
  "react/button-has-type": "warn",
  "react/exhaustive-effect-dependencies": "warn",
  "react/function-component-definition": "warn",
  "react/iframe-missing-sandbox": "warn",
  "react/purity": "warn",
  "react/set-state-in-effect": "warn",
  "react/todo": "warn",
  "typescript/array-type": "warn",
  "typescript/no-explicit-any": "warn",
  "typescript/no-non-null-assertion": "warn",
  "unicorn/consistent-function-scoping": "warn",
  "unicorn/custom-error-definition": "warn",
  "unicorn/import-style": "warn",
  "unicorn/no-array-reverse": "warn",
  "unicorn/no-array-sort": "warn",
  "unicorn/no-await-expression-member": "warn",
  "unicorn/prefer-add-event-listener": "warn",
  "unicorn/prefer-type-error": "warn",
  "typescript/consistent-return": "warn",
  "typescript/no-base-to-string": "warn",
  "typescript/no-confusing-void-expression": "warn",
  "typescript/no-deprecated": "warn",
  "typescript/no-floating-promises": "warn",
  "typescript/no-misused-promises": "warn",
  "typescript/no-unnecessary-type-assertion": "warn",
  "typescript/no-unsafe-argument": "warn",
  "typescript/no-unsafe-assignment": "warn",
  "typescript/no-unsafe-call": "warn",
  "typescript/no-unsafe-member-access": "warn",
  "typescript/no-unsafe-return": "warn",
  "typescript/no-unsafe-type-assertion": "warn",
  "typescript/prefer-nullish-coalescing": "warn",
  "typescript/promise-function-async": "warn",
  "typescript/restrict-template-expressions": "warn",
  "typescript/return-await": "warn",
  "typescript/strict-boolean-expressions": "warn",
  "typescript/strict-void-return": "warn",
  "typescript/use-unknown-in-catch-callback-variable": "warn",
} as const;

export default defineConfig({
  extends: [core, react, antiSlop],
  // Package boundaries are declared once in tools/graph.ts; running them as a
  // lint rule puts them in the editor and in check:fast, not only in check.
  jsPlugins: ["./tools/oxlint/boundaries.ts"],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "var/**",
    "dist/**",
    "apps/web/dist/**",
    ".venv/**",
    ".expect/**",
    ".invok/**",
    ".claude/**",
    ".codex/**",
    ".grok/**",
  ],
  rules: {
    "boundaries/no-cross-boundary-import": "error",
    "eslint/sort-keys": "off",
    "eslint/default-case": "off",
    // Effect Schema's contract idiom declares a value and its type under one
    // name; `tsc` still reports a genuine value/value redeclaration as TS2451.
    "eslint/no-redeclare": "off",
    // `Schema.TaggedError`/`Context.Service` make `class` a declaration keyword,
    // so a per-file limit of 1 is the wrong shape; 3 keeps a real ceiling.
    "eslint/max-classes-per-file": ["error", 3],
    // False positive against Effect's tagged-error idiom.
    "unicorn/throw-new-error": "off",
    ...transitional,
  },
});
