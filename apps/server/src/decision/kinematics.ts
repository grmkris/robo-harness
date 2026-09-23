import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Joint } from "@robo/domain";

/**
 * Coordinator-side forward kinematics of the lab URDF, matching
 * python/robo_harness/kinematics.py (zero joint offsets, uncalibrated), plus a
 * damped least-squares solver for small top-down Cartesian displacements.
 * Used only to plan bounded joint moves; the motor owner still validates.
 */
export type Mat4 = number[][];
export type Vec3 = [number, number, number];
export type ArmPose = Readonly<Record<Joint, number>>;
/** Joint angles by name; partial poses leave joints at zero. */
export type JointAngles = Partial<Record<string, number>>;
export type FrameMap = Map<string, Mat4>;

/** Mutable joint angles while solving. */
interface SolverPose {
  [joint: string]: number | undefined;
}

interface UrdfJoint {
  readonly name: string;
  readonly type: string;
  readonly parent: string;
  readonly child: string;
  readonly xyz: Vec3;
  readonly rpy: Vec3;
  readonly axis: Vec3;
}

const vec = (text: string | undefined): Vec3 => {
  const parts = (text ?? "0 0 0").trim().split(/\s+/u).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};

const attribute = (block: string, tag: string, name: string) =>
  new RegExp(`<${tag}[^>]*\\s${name}="(?<value>[^"]*)"`, "u").exec(block)
    ?.groups?.["value"];

const parseUrdf = (text: string): UrdfJoint[] =>
  [
    ...text.matchAll(
      /<joint\s[^>]*name="(?<name>[^"]+)"[^>]*type="(?<type>[^"]+)"[^>]*>(?<body>[\s\S]*?)<\/joint>/gu
    ),
  ].map((match) => {
    const body = match.groups?.["body"] ?? "";
    return {
      name: match.groups?.["name"] ?? "",
      type: match.groups?.["type"] ?? "",
      parent: attribute(body, "parent", "link") ?? "",
      child: attribute(body, "child", "link") ?? "",
      xyz: vec(attribute(body, "origin", "xyz")),
      rpy: vec(attribute(body, "origin", "rpy")),
      axis: vec(attribute(body, "axis", "xyz")),
    };
  });

const identity = (): Mat4 => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

const multiply = (a: Mat4, b: Mat4): Mat4 =>
  a.map((row) =>
    [0, 1, 2, 3].map((j) =>
      row.reduce((sum, value, k) => sum + value * (b[k]?.[j] ?? 0), 0)
    )
  );

/** Extrinsic xyz Euler angles, as scipy Rotation.from_euler("xyz", ...). */
const fromRpy = ([r, p, y]: Vec3, [tx, ty, tz]: Vec3 = [0, 0, 0]): Mat4 => {
  const [cr, sr, cp, sp, cy, sy] = [
    Math.cos(r),
    Math.sin(r),
    Math.cos(p),
    Math.sin(p),
    Math.cos(y),
    Math.sin(y),
  ];
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, tx],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, ty],
    [-sp, cp * sr, cp * cr, tz],
    [0, 0, 0, 1],
  ];
};

/** Rotation about a unit axis, as scipy Rotation.from_rotvec(axis * angle). */
const aboutAxis = ([x, y, z]: Vec3, angle: number): Mat4 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0],
    [0, 0, 0, 1],
  ];
};

const urdfPath = join(import.meta.dir, "../../../../assets/so101.urdf");
let cached: UrdfJoint[] | null = null;
const labJoints = () => {
  cached ??= parseUrdf(readFileSync(urdfPath, "utf-8"));
  return cached;
};

const frames = (
  pose: JointAngles,
  joints: readonly UrdfJoint[] = labJoints()
): FrameMap => {
  const out: FrameMap = new Map([["base_link", identity()]]);
  const pending = [...joints];
  while (pending.length > 0) {
    const index = pending.findIndex((joint) => out.has(joint.parent));
    if (index === -1) throw new Error("URDF has an unresolved frame graph");
    const [joint] = pending.splice(index, 1);
    if (!joint) break;
    const parent = out.get(joint.parent) ?? identity();
    let local = fromRpy(joint.rpy, joint.xyz);
    if (
      (joint.type === "revolute" || joint.type === "continuous") &&
      joint.name !== "gripper"
    ) {
      local = multiply(
        local,
        aboutAxis(joint.axis, ((pose[joint.name] ?? 0) * Math.PI) / 180)
      );
    }
    out.set(joint.child, multiply(parent, local));
  }
  return out;
};

export const tipFrame = (pose: JointAngles): Mat4 =>
  frames(pose).get("gripper_frame_link") ?? identity();

export const position = (m: Mat4): Vec3 => [
  m[0]?.[3] ?? 0,
  m[1]?.[3] ?? 0,
  m[2]?.[3] ?? 0,
];

/** Position of a point expressed in the gripper frame, in base_link metres. */
export const toolPoint = (
  m: Mat4,
  offset: readonly [number, number, number]
): Vec3 => [
  (m[0]?.[3] ?? 0) +
    offset.reduce((sum, v, i) => sum + v * (m[0]?.[i] ?? 0), 0),
  (m[1]?.[3] ?? 0) +
    offset.reduce((sum, v, i) => sum + v * (m[1]?.[i] ?? 0), 0),
  (m[2]?.[3] ?? 0) +
    offset.reduce((sum, v, i) => sum + v * (m[2]?.[i] ?? 0), 0),
];

/** 1 when the gripper's approach axis (frame +z) points straight down. */
export const downness = (m: Mat4): number => -(m[2]?.[2] ?? 0);

const planned: readonly Joint[] = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
];

const solve = (a: number[][], b: number[]): number[] => {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0))
        pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot] ?? [], m[col] ?? []];
    const lead = m[col]?.[col] ?? 1;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = (m[r]?.[col] ?? 0) / lead;
      for (let c = col; c <= n; c += 1) {
        const row = m[r];
        if (row) row[c] = (row[c] ?? 0) - factor * (m[col]?.[c] ?? 0);
      }
    }
  }
  return m.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
};

export interface ReachResult {
  readonly pose: ArmPose;
  readonly errorM: number;
  readonly downness: number;
}

/**
 * Joint pose whose tip reaches `target` with the gripper pointing down,
 * found by damped least squares from `start` over pan/lift/elbow/wrist_flex.
 * wrist_roll and gripper are left unchanged.
 */
export const reach = (
  start: ArmPose,
  target: Vec3,
  limits: Readonly<Record<string, readonly [number, number]>>,
  iterations = 60,
  offset: readonly [number, number, number] = [0, 0, 0]
): ReachResult => {
  const pose: SolverPose = { ...start };
  const residual = (p: JointAngles) => {
    const m = tipFrame(p);
    const [x, y, z] = toolPoint(m, offset);
    return [
      (x - target[0]) * 100,
      (y - target[1]) * 100,
      (z - target[2]) * 100,
      (downness(m) - 1) * 30,
    ];
  };
  for (let i = 0; i < iterations; i += 1) {
    const r = residual(pose);
    const jac = r.map(() => planned.map(() => 0));
    for (const [col, joint] of planned.entries()) {
      const bumped = { ...pose, [joint]: (pose[joint] ?? 0) + 0.25 };
      for (const [row, value] of residual(bumped).entries()) {
        const rowRef = jac[row];
        if (rowRef) rowRef[col] = (value - (r[row] ?? 0)) / 0.25;
      }
    }
    const lambda = 0.05;
    const jtj = planned.map((_, a) =>
      planned.map(
        (__, b) =>
          jac.reduce((sum, row) => sum + (row[a] ?? 0) * (row[b] ?? 0), 0) +
          (a === b ? lambda : 0)
      )
    );
    const jtr = planned.map((_, a) =>
      jac.reduce((sum, row, k) => sum + (row[a] ?? 0) * (r[k] ?? 0), 0)
    );
    const step = solve(jtj, jtr);
    for (const [k, joint] of planned.entries()) {
      const [low, high] = limits[joint] ?? [-180, 180];
      pose[joint] = Math.min(
        high,
        Math.max(
          low,
          (pose[joint] ?? 0) - Math.max(-10, Math.min(10, step[k] ?? 0))
        )
      );
    }
  }
  const m = tipFrame(pose);
  const [x, y, z] = toolPoint(m, offset);
  return {
    pose: pose as ArmPose,
    errorM: Math.hypot(x - target[0], y - target[1], z - target[2]),
    downness: downness(m),
  };
};
