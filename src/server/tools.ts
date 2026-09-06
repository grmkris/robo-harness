import { tool, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";

import type { Frame } from "../shared/contracts";
import { toolSchemas, type ToolName } from "../shared/contracts";
import { perceive } from "./perception";
import { startRecording, stopRecording } from "./recordings";
import * as robot from "./robot";
import { shell } from "./shell";
export interface Principal {
  owner: string;
  human: boolean;
}
export const descriptions: Record<ToolName, string> = {
  observe:
    "Read current measured/commanded joints, Cartesian pose, control owner, limits, camera freshness, and faults.",
  capture:
    "Capture a fresh workspace or wrist camera frame. Image and exact capture metadata are returned.",
  acquire:
    "Acquire a three-second control lease. Agents cannot take over human or leader control.",
  renew:
    "Renew your own control lease. Call while intentionally controlling the arm; expiry cancels motion.",
  release: "Release your control lease and hold the last commanded position.",
  move: "Submit a bounded joint or position-only Cartesian move. Degrees for joints, 0–100 gripper, meters in base_link for xyz. Returns operation ID, not completion.",
  operation: "Read measured completion or failure of a submitted motion.",
  stop: "Cancel motion, revoke control, and hold. Does not release motor torque.",
  perceive:
    "Run configured segmentation or depth against an identified camera frame, within the operator-approved compute budget.",
  recording_start: "Begin a camera/action recording with explicit provenance.",
  recording_stop:
    "Stop capture and preserve a recording for LeRobot export and Rerun replay.",
  shell:
    "Run development code in an isolated Netcup container or configured Pi development account. No deployed hardware configuration access.",
};
export async function executeTool(
  name: ToolName,
  raw: unknown,
  p: Principal,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted();
  const input = toolSchemas[name].parse(raw);
  switch (name) {
    case "observe":
      return robot.freshObservation();
    case "capture":
      return robot.capture((input as { camera: string }).camera);
    case "acquire": {
      const v = input as { mode: string; takeover: boolean };
      return robot.acquire(p.owner, v.mode, v.takeover, p.human);
    }
    case "renew":
      return robot.renew(p.owner);
    case "release":
      return robot.release(p.owner);
    case "move":
      return robot.move(p.owner, input as robot.MoveInput);
    case "operation":
      return robot.operation((input as { id: string }).id);
    case "stop":
      return robot.stop();
    case "perceive":
      return perceive(input as Parameters<typeof perceive>[0], signal);
    case "recording_start":
      return startRecording((input as { label: string }).label);
    case "recording_stop":
      return stopRecording();
    case "shell":
      return shell(input as Parameters<typeof shell>[0], p.owner, signal);
  }
}
export function agentTools(
  p: Principal,
  signal: AbortSignal,
  vision: boolean,
  onImage?: (frame: Frame) => void
): ToolSet {
  return Object.fromEntries(
    (Object.keys(toolSchemas) as ToolName[]).map((name) => [
      name,
      tool({
        description: descriptions[name],
        inputSchema: jsonSchema<Record<string, unknown>>(
          z.toJSONSchema(toolSchemas[name], { io: "input" })
        ),
        execute: async (input: Record<string, unknown>) => {
          try {
            const output = await executeTool(name, input, p, signal);
            if (name === "capture") {
              const frame = output as Frame;
              if (vision) onImage?.(frame);
              return {
                ...frame,
                base64: undefined,
                note: vision
                  ? "Image supplied in the following observation message"
                  : "Selected model is not configured for vision",
              };
            }
            return output;
          } catch (e) {
            return { error: e instanceof Error ? e.message : "Tool failed" };
          }
        },
        toModelOutput: ({ output }: { output: unknown }) => ({
          type: "text" as const,
          value: JSON.stringify(output),
        }),
      }),
    ])
  );
}
