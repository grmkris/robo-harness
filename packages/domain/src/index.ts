// Robot value types shared by the coordinator, the workbench and the CLI.
export const joints = [
  "shoulder_pan",
  "shoulder_lift",
  "elbow_flex",
  "wrist_flex",
  "wrist_roll",
  "gripper",
] as const;
export type Joint = (typeof joints)[number];
type Pose = Record<Joint, number>;
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
