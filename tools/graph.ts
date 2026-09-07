/**
 * The single architectural declaration for this repository.
 *
 * Every dependency rule is stated here once. `tools/oxlint/boundaries.ts` turns
 * these entries into lint diagnostics that fire in the editor and in
 * `bun run check:fast`, so a boundary violation is visible while it is written
 * rather than at the end of a session. If a rule is not in this file, it is not
 * a rule.
 */

/** Where a workspace sits in the dependency order. */
type Layer = "app" | "contract" | "foreign";

export interface Node {
  /** Workspace directory, relative to the repository root. */
  readonly dir: string;
  /** Package name, or null for workspaces that are not TypeScript. */
  readonly name: string | null;
  readonly layer: Layer;
  /** One sentence. What this workspace owns. */
  readonly role: string;
  /** Workspace packages this one may import. Empty means leaf. */
  readonly mayImport: readonly string[];
  /**
   * External packages this workspace may import, matched on the package prefix.
   * An allowlist, not a denylist. Omit entirely to mean unrestricted; only
   * composition roots, which legitimately reach for anything, should omit it.
   */
  readonly mayUse?: readonly string[];
  /**
   * Required when a workspace is unreachable from any app, and forbidden when
   * it is reachable, so a seam cannot quietly outlive the reason it was kept.
   */
  readonly seam?: { readonly consumer: string; readonly reason: string };
}

/** Module specifiers every workspace may use, regardless of its allowlist. */
export const alwaysAllowed: readonly string[] = ["bun", "bun:test"];

export const nodes: readonly Node[] = [
  {
    dir: "apps/server",
    name: "@robo/server",
    layer: "app",
    role: "Bun process and coordinator; owns leases, the sampler, chat runs and MCP.",
    mayImport: ["@robo/domain", "@robo/protocol"],
  },
  {
    dir: "apps/cli",
    name: "@robo/cli",
    layer: "app",
    role: "Operator CLI, MCP server, and real-arm smoke.",
    mayImport: ["@robo/protocol"],
  },
  {
    dir: "apps/web",
    name: "@robo/web",
    layer: "app",
    role: "React workbench; consumes the coordinator's API.",
    mayImport: ["@robo/domain"],
  },
  {
    dir: "packages/domain",
    name: "@robo/domain",
    layer: "contract",
    role: "Robot value types shared across the coordinator, workbench and CLI.",
    mayImport: [],
    mayUse: ["effect"],
  },
  {
    dir: "packages/protocol",
    name: "@robo/protocol",
    layer: "contract",
    role: "Tool wire schemas and the typed HTTP client.",
    mayImport: ["@robo/domain"],
    mayUse: ["effect", "@standard-schema/spec"],
  },
  {
    dir: "python",
    name: null,
    layer: "foreign",
    role: "LeRobot motor owner, Rerun worker and perception worker.",
    mayImport: [],
    seam: {
      consumer: "apps/server",
      reason: "HTTP boundary to the motor owner; never imported as a module.",
    },
  },
];
