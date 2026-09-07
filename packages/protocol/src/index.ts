import { joints } from "@robo/domain";
import { z } from "zod";
export { callTool } from "./client";
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
