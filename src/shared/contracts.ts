import { z } from "zod";

export const joints = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;
export type Joint = (typeof joints)[number];
export type Pose = Record<Joint, number>;
export interface Observation {
  boot_id: string;
  seq: number;
  monotonic_s: number;
  wall_time_ms: number;
  server_time_ms?: number;
  clock_domain: string;
  age_ms: number;
  units: Record<string, string>;
  backend: "mock" | "so101";
  calibration_id: string;
  measured: Pose;
  commanded: Pose;
  ee: number[];
  frames: Record<string, number[][]>;
  cameras: Record<
    string,
    { seq: number; age_ms: number | null; error: string | null }
  >;
  operator: { owner: string; mode: string; remaining_ms: number } | null;
  operation: Operation | null;
  fault: string | null;
  limits: Record<Joint, [number, number]>;
  max_step: number;
  cartesian: boolean;
  trajectory: number[][];
}
export interface Operation {
  id: string;
  request_id: string;
  owner: string;
  status: "accepted" | "running" | "completed" | "cancelled" | "failed";
  target: Pose;
  residual: Pose | null;
  reason?: string;
}
export interface Frame {
  id: string;
  camera: string;
  seq: number;
  monotonic_s: number;
  wall_time_ms: number;
  clock_domain: string;
  age_ms: number;
  width: number;
  height: number;
  media_type: string;
  base64: string;
  calibration?: Record<string, unknown>;
}
export interface Lease {
  lease_id: string;
  ttl_ms: number;
  owner: string;
  mode: string;
}
export interface AppEvent {
  id: number;
  time: number;
  type: string;
  data: Record<string, unknown>;
}
export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  model: string;
  vision: boolean;
  reason?: string;
}
export const moveSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    target: z.partialRecord(z.enum(joints), z.number().finite()).optional(),
    xyz: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
    duration_s: z.number().min(0.1).max(10).default(1),
  })
  .strict()
  .refine(
    (v) => (v.target === undefined) !== (v.xyz === undefined),
    "Specify joints or Cartesian target"
  );
export const toolSchemas = {
  observe: z.object({}),
  capture: z.object({ camera: z.enum(["workspace", "wrist"]) }),
  acquire: z.object({
    mode: z.enum(["agent", "human", "leader"]).default("agent"),
    takeover: z.boolean().default(false),
  }),
  release: z.object({}),
  renew: z.object({}),
  move: moveSchema,
  operation: z.object({ id: z.string() }),
  stop: z.object({}),
  perceive: z.object({
    camera: z.enum(["workspace", "wrist"]),
    kind: z.enum(["segment", "depth"]),
    prompt: z.string().max(200).default("object"),
    frame_id: z.string().optional(),
  }),
  recording_start: z.object({ label: z.string().min(1).max(120) }),
  recording_stop: z.object({}),
  shell: z.object({
    command: z.string().min(1).max(16_000),
    host: z.enum(["netcup", "pi"]).default("netcup"),
    timeout_s: z.number().min(1).max(120).default(30),
  }),
} as const;
export type ToolName = keyof typeof toolSchemas;
