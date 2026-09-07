import type { Frame } from "@robo/domain";
import {
  toolInputSchema,
  toolSchemas,
  type MoveInput,
  type ToolName,
} from "@robo/protocol";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { Schema } from "effect";

import { decode } from "./decode";
import { perceive } from "./perception";
import { startRecording, stopRecording } from "./recordings";
import * as robot from "./robot";
import { shell } from "./shell";

export interface Principal {
  owner: string;
  human: boolean;
}
const descriptions: Record<ToolName, string> = {
  observe:
    "Read current measured/commanded joints, Cartesian pose, control owner, limits, camera freshness, and faults.",
  capture:
    "Capture a fresh workspace or wrist camera frame. Image and exact capture metadata are returned.",
  acquire:
    "Acquire a three-second control lease. Agents cannot take over human or leader control.",
  renew:
    "Renew your own control lease. Call while intentionally controlling the arm; expiry cancels motion.",
  release: "Release your control lease and hold the last commanded position.",
  move: "Submit a bounded joint or position-only Cartesian move and wait for measured completion. Degrees for joints, 0–100 gripper, meters in base_link for xyz. Returns the final operation (status completed/cancelled/failed and residual); an accepted status means it did not finish in time — read operation to keep watching.",
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
  const input = decode(toolSchemas[name], raw);
  switch (name) {
    case "observe": {
      return robot.freshObservation();
    }
    case "capture": {
      return robot.capture((input as { camera: string }).camera);
    }
    case "acquire": {
      const v = input as { mode: string; takeover: boolean };
      return robot.acquire(p.owner, v.mode, v.takeover, p.human);
    }
    case "renew": {
      return robot.renew(p.owner);
    }
    case "release": {
      return robot.release(p.owner);
    }
    case "move": {
      return robot.move(p.owner, input as MoveInput);
    }
    case "operation": {
      return robot.operation((input as { id: string }).id);
    }
    case "stop": {
      return robot.stop();
    }
    case "perceive": {
      return perceive(input as Parameters<typeof perceive>[0], signal);
    }
    case "recording_start": {
      return startRecording((input as { label: string }).label);
    }
    case "recording_stop": {
      return stopRecording();
    }
    case "shell": {
      return shell(input as Parameters<typeof shell>[0], p.owner, signal);
    }
  }
}
const TERMINAL = new Set(["completed", "cancelled", "failed"]);
const POLL_MS = 400;
const COMPLETION_MARGIN_MS = 2000;
// The chat agent's move waits for measured completion, mirroring
// `robo_harness.client.Robot.move()`: submit, then renew the lease and poll the
// operation until it reaches a terminal state or the motion's own deadline
// passes. Renewing ONLY here — never for the whole turn — is what lets the
// three-second lease lapse when the model idles between tools, so the motor
// owner cancels motion in the safe direction.
async function moveToCompletion(
  input: MoveInput,
  owner: string,
  signal: AbortSignal
): Promise<unknown> {
  let op = await robot.move(owner, input);
  const deadline =
    Date.now() + (input.duration_s ?? 1) * 1000 + COMPLETION_MARGIN_MS;
  while (!TERMINAL.has(op.status) && Date.now() < deadline) {
    signal.throwIfAborted();
    await robot.renew(owner).catch(() => {});
    await Bun.sleep(POLL_MS);
    op = await robot.operation(op.id);
  }
  return op;
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
          toolInputSchema(name),
          {
            validate: (value) => {
              try {
                return {
                  success: true,
                  value: Schema.decodeUnknownSync(toolSchemas[name], {
                    onExcessProperty: "error",
                  })(value) as Record<string, unknown>,
                };
              } catch (error) {
                return {
                  success: false,
                  error:
                    error instanceof Error
                      ? error
                      : new Error("Invalid tool input"),
                };
              }
            },
          }
        ),
        // Errors are thrown, not returned as `{ error }`: the SDK turns a
        // rejected execute into a tool-error part the model reads as a failure
        // and the loop reports as `chat.tool_error`.
        execute: async (input: Record<string, unknown>) => {
          if (name === "move") {
            return moveToCompletion(
              decode(toolSchemas.move, input),
              p.owner,
              signal
            );
          }
          const output = await executeTool(name, input, p, signal);
          if (name === "capture") {
            const frame = output as Frame;
            if (vision) {
              onImage?.(frame);
            }
            return {
              ...frame,
              base64: undefined,
              note: vision
                ? "Image supplied in the following observation message"
                : "Selected model is not configured for vision",
            };
          }
          return output;
        },
        toModelOutput: ({ output }: { output: unknown }) => ({
          type: "text" as const,
          value: JSON.stringify(output),
        }),
      }),
    ])
  );
}
