import { nodes } from "./graph.ts";

/**
 * Whole-repository properties of the declaration in `tools/graph.ts`.
 *
 * Per-file import rules are enforced by `tools/oxlint/boundaries.ts`, which runs
 * in the editor. The checks here need the whole workspace set at once: that a
 * package is registered, that its declared edges match its manifest, and that
 * nothing sits unreachable and unexplained. package.json is an I/O boundary, so
 * it is read and shape-checked before use.
 */

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly workspaces?: readonly string[];
}

async function readManifest(path: string): Promise<Manifest> {
  const raw: unknown = await Bun.file(path).json();
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${path} is not a JSON object`);
  }
  return raw as Manifest;
}

const root = await readManifest("package.json");
const failures: string[] = [];

async function scanPattern(pattern: string): Promise<string[]> {
  const found: string[] = [];
  const glob = new Bun.Glob(`${pattern}/package.json`);
  for await (const match of glob.scan({ onlyFiles: true })) {
    found.push(match.replace(/\/package\.json$/u, ""));
  }
  return found;
}

const scanned = await Promise.all((root.workspaces ?? []).map(scanPattern));
const workspaceDirs = scanned.flat();

// 1. Every workspace is declared, and every declaration is a real workspace.
const declaredDirs = new Set(nodes.map((node) => node.dir));
for (const dir of workspaceDirs) {
  if (!declaredDirs.has(dir)) {
    failures.push(
      `${dir} is a workspace but has no entry in tools/graph.ts. Add one naming what it owns and what it may import.`
    );
  }
}
for (const node of nodes) {
  if (!workspaceDirs.includes(node.dir)) {
    failures.push(
      `tools/graph.ts declares ${node.dir}, which is not a workspace. Remove the entry or add the package.`
    );
  }
}

// 2. Declared edges and manifest dependencies agree, both directions.
const byName = new Map(
  nodes
    .filter((node) => node.name !== null)
    .map((node) => [node.name ?? "", node])
);
const declaredWorkspaces = nodes.filter((node) =>
  workspaceDirs.includes(node.dir)
);
const manifests = await Promise.all(
  declaredWorkspaces.map((node) => readManifest(`${node.dir}/package.json`))
);
for (const [index, node] of declaredWorkspaces.entries()) {
  const deps = Object.keys(manifests[index]?.dependencies ?? {});
  const workspaceDeps = deps.filter((dep) => byName.has(dep));
  for (const edge of node.mayImport) {
    if (!workspaceDeps.includes(edge)) {
      failures.push(
        `${node.dir} declares mayImport "${edge}" in tools/graph.ts, but ${node.dir}/package.json does not depend on it.`
      );
    }
  }
  for (const dep of workspaceDeps) {
    if (!node.mayImport.includes(dep)) {
      failures.push(
        `${node.dir}/package.json depends on ${dep}, but tools/graph.ts does not list it in mayImport.`
      );
    }
  }
}

// 3. A package unreachable from an app must say why, and a reachable one must
// not carry a stale excuse for existing.
const reachable = new Set<string>();
function visit(name: string): void {
  const node = byName.get(name);
  if (node === undefined || reachable.has(node.dir)) {
    return;
  }
  reachable.add(node.dir);
  for (const edge of node.mayImport) {
    visit(edge);
  }
}
for (const node of nodes) {
  if (node.layer === "app") {
    reachable.add(node.dir);
    for (const edge of node.mayImport) {
      visit(edge);
    }
  }
}
for (const node of nodes) {
  const isReachable = reachable.has(node.dir);
  if (!isReachable && node.seam === undefined) {
    failures.push(
      `${node.dir} is not reachable from any app and declares no seam. Wire it into a slice, delete it, or declare seam: { consumer, reason }.`
    );
  }
  if (isReachable && node.seam !== undefined) {
    failures.push(
      `${node.dir} is reachable from an app but still declares a seam ("${node.seam.reason}"). Remove the seam; it has been wired.`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.info(
    `Graph check passed (${nodes.length} workspaces, ${reachable.size} reachable from an app)`
  );
}
