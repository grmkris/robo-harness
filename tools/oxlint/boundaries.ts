import { definePlugin, defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

import { alwaysAllowed, nodes } from "../graph.ts";
import type { Node } from "../graph.ts";

/**
 * Enforces the import rules declared in `tools/graph.ts`.
 *
 * This runs as an Oxlint plugin rather than a standalone script so it fires in
 * the editor and in `check:fast`. The research this repository is built from
 * calls the simulation boundary "the one an agent will erode first and the one
 * that's invisible in a diff" - a check an agent only meets at the end of a
 * session is a check it has already worked around.
 *
 * The AST is the reason this is a lint rule and not a text scan:
 * `Bun.Transpiler.scanImports` silently drops type-only imports, so
 * `import type { Mesh } from "three"` inside game-core would pass a scanner.
 */

const byLongestDir = nodes.toSorted((a, b) => b.dir.length - a.dir.length);

const ownerOf = (filename: string): Node | undefined =>
  byLongestDir.find(
    (node) =>
      filename.includes(`/${node.dir}/`) || filename.startsWith(`${node.dir}/`)
  );

/** Matches a package prefix, so `viem/chains` resolves to `viem`. */
const covers = (allowed: readonly string[], specifier: string): boolean =>
  allowed.some(
    (entry) => specifier === entry || specifier.startsWith(`${entry}/`)
  );

const isRelative = (specifier: string): boolean =>
  specifier.startsWith(".") || specifier.startsWith("#");

const isWorkspace = (specifier: string): boolean =>
  specifier.startsWith("@robo/");

/** The statement forms that name a module specifier. */
type Declared =
  | ESTree.ImportDeclaration
  | ESTree.ExportAllDeclaration
  | ESTree.ExportNamedDeclaration;
type Sourced = Declared | ESTree.ImportExpression;

const noCrossBoundaryImport = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imports that are not declared for this workspace in tools/graph.ts.",
    },
    messages: {
      workspace:
        "`{{specifier}}` is not importable from {{dir}}. Its declared workspace imports are: {{allowed}}. Either drop the import, or add the edge to that node's `mayImport` in tools/graph.ts and record why in docs/decisions/.",
      external:
        "`{{specifier}}` is not in the allowlist for {{dir}}, which owns: {{role}} Either drop the import, or add the package to that node's `mayUse` in tools/graph.ts and record why in docs/decisions/.",
    },
    schema: [],
  },
  createOnce(context: Context) {
    // `context.filename` is only readable per file, not during registration,
    // so the owning workspace is resolved on first use and cached.
    const owners = new Map<string, Node | undefined>();
    const currentOwner = (): Node | undefined => {
      const { filename } = context;
      if (!owners.has(filename)) {
        owners.set(filename, ownerOf(filename));
      }
      return owners.get(filename);
    };

    const check = (specifier: string, node: Sourced): void => {
      const owner = currentOwner();
      if (owner === undefined) {
        return;
      }
      if (isRelative(specifier) || covers(alwaysAllowed, specifier)) {
        return;
      }
      if (isWorkspace(specifier)) {
        if (covers(owner.mayImport, specifier)) {
          return;
        }
        context.report({
          messageId: "workspace",
          data: {
            specifier,
            dir: owner.dir,
            allowed:
              owner.mayImport.length === 0
                ? "none, it is a leaf"
                : owner.mayImport.join(", "),
          },
          node,
        });
        return;
      }
      // An omitted allowlist means unrestricted, for composition roots only.
      if (owner.mayUse === undefined || covers(owner.mayUse, specifier)) {
        return;
      }
      context.report({
        messageId: "external",
        data: { specifier, dir: owner.dir, role: owner.role },
        node,
      });
    };

    const fromSource = (node: Declared): void => {
      if (node.source !== null && node.source !== undefined) {
        check(node.source.value, node);
      }
    };

    return {
      ImportDeclaration: fromSource,
      ExportAllDeclaration: fromSource,
      ExportNamedDeclaration: fromSource,
      // A dynamic import only names a boundary when its specifier is literal.
      // `import(someVariable)` is unresolvable here and is left to review.
      ImportExpression: (node: ESTree.ImportExpression): void => {
        if (node.source.type !== "Literal") {
          return;
        }
        // Oxlint tags every literal kind `"Literal"` and separates them only by
        // the type of `value`. Rendering it is enough here: a specifier that is
        // not a string cannot resolve to a package under any allowlist.
        const { value } = node.source;
        if (value !== null) {
          check(String(value), node);
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: "boundaries" },
  rules: { "no-cross-boundary-import": noCrossBoundaryImport },
});
