import { Frame } from "@robo/domain";
import {
  Duration,
  JointTarget,
  std,
  toolInputSchema,
  toolSchemas,
  type ToolName,
} from "@robo/protocol";
import { toolDefinition, type Tool } from "@tanstack/ai";
import { Schema } from "effect";

import { actionLedger } from "./action-ledger";
import { config } from "./config";
import { decode } from "./decode";
import { createMotionExecutor, type MotionProgress } from "./motion-actions";
import { perceptionConfig } from "./perception";
import * as robot from "./robot";
import { ToolFailure } from "./tool-errors";
import { descriptions, executeTool, type Principal } from "./tools";

const executor = createMotionExecutor(robot.motionIO, actionLedger);
const schemas = {
  observe: toolSchemas.observe,
  capture: toolSchemas.capture,
  move_joints: Schema.Struct({ target: JointTarget, duration_s: Duration }),
  move_cartesian: Schema.Struct({
    xyz: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]),
    duration_s: Duration,
  }),
  stop: toolSchemas.stop,
  discover_tools: Schema.Struct({
    group: Schema.Literals([
      "recording",
      "perception",
      "development",
      "cartesian",
    ]),
  }),
  perceive: toolSchemas.perceive,
  recording_start: toolSchemas.recording_start,
  recording_stop: toolSchemas.recording_stop,
  recording_list: toolSchemas.recording_list,
  recording_inspect: toolSchemas.recording_inspect,
  recording_frame: toolSchemas.recording_frame,
  recording_export: toolSchemas.recording_export,
  shell: toolSchemas.shell,
};
type ChatToolName = keyof typeof schemas;
const groups = {
  recording: [
    "recording_start",
    "recording_stop",
    "recording_list",
    "recording_inspect",
    "recording_frame",
    "recording_export",
  ],
  perception: ["perceive"],
  development: ["shell"],
  cartesian: ["move_cartesian"],
} as const;
const basic: ChatToolName[] = [
  "observe",
  "capture",
  "move_joints",
  "stop",
  "discover_tools",
];
const mutations = new Set<ChatToolName>([
  "move_joints",
  "move_cartesian",
  "shell",
  "perceive",
  "recording_start",
  "recording_stop",
  "recording_export",
]);
const jointExample = '{"target":{"elbow_flex":96.3},"duration_s":1}';

export const createChatTools = (options: {
  principal: Principal;
  signal: AbortSignal;
  vision: boolean;
  runId: string;
  onImage: (frame: Frame) => void;
  onProgress: (event: MotionProgress) => void;
  steerRevision?: () => number;
}) => {
  let step = 0;
  let mutatedStep = -1;
  let motionDisabled = false;
  const enabled = new Set<ChatToolName>(basic);
  let offered = new Set<ChatToolName>();
  const describe: Record<ChatToolName, string> = {
    ...descriptions,
    move_joints: `Move to a bounded joint target and wait for measured completion. The runtime handles control and renewal. Supply numbers, never quoted numbers. Angles are degrees, gripper is 0–100. One motion per response. Example shape: ${jointExample}; choose values from a fresh observation, within max_step. Do not retry an unknown outcome.`,
    move_cartesian:
      'Move to a commissioned Cartesian position in meters in base_link and wait for measured completion. Example shape: {"xyz":[0.2,0,0.1],"duration_s":1}. Observe first and choose a valid reachable target.',
    discover_tools:
      "Enable additional tools for a task in the NEXT response: recording (record demonstrations), perception (segmentation/depth within budget), development (isolated programs), or cartesian (commissioned Cartesian movement). Returns availability and tool names.",
  };
  const tools: Tool[] = (Object.keys(schemas) as ChatToolName[]).map((name) => {
    const schema = schemas[name];
    const advertised = Object.hasOwn(toolSchemas, name)
      ? toolInputSchema(name as ToolName)
      : std(schema)["~standard"].jsonSchema.input({
          target: "draft-2020-12",
        });
    const standard = std(schema);
    const definition = toolDefinition({
      name,
      description: describe[name],
      inputSchema: {
        "~standard": {
          ...standard["~standard"],
          validate: (value: unknown) => {
            const result = standard["~standard"].validate(value);
            if (result instanceof Promise)
              throw new Error("Chat tool schemas must validate synchronously");
            return result.issues
              ? {
                  issues: result.issues.map((issue) => ({
                    ...issue,
                    message: `${issue.message} at ${JSON.stringify(issue.path ?? [])}`,
                  })),
                }
              : result;
          },
          jsonSchema: {
            input: (
              options: Parameters<
                (typeof standard)["~standard"]["jsonSchema"]["input"]
              >[0]
            ) =>
              Object.hasOwn(toolSchemas, name)
                ? advertised
                : standard["~standard"].jsonSchema.input(options),
            output: () => advertised,
          },
        },
      },
    }).server(async (input, context) => {
      const toolCallId = context?.toolCallId;
      if (!toolCallId)
        throw new ToolFailure({
          code: "INVALID_INPUT",
          detail: "Missing tool call identity",
        });
      const signal = context?.abortSignal
        ? AbortSignal.any([options.signal, context.abortSignal])
        : options.signal;
      signal.throwIfAborted();
      if (
        !offered.has(name) ||
        (motionDisabled &&
          (name === "move_joints" || name === "move_cartesian"))
      ) {
        throw new ToolFailure({
          code: "TOOL_NOT_AVAILABLE",
          detail:
            "This tool is not available in the current step. Use discover_tools or report the last outcome.",
        });
      }
      if (mutations.has(name)) {
        if (mutatedStep === step)
          throw new ToolFailure({
            code: "MOTION_BUSY",
            detail:
              "Only one action may run per response. Wait for its result before requesting another action.",
          });
        mutatedStep = step;
      }
      if (name === "discover_tools") {
        const { group } = decode(schemas.discover_tools, input);
        const perception = perceptionConfig();
        const unavailable =
          group === "cartesian" && !robot.current?.cartesian
            ? "Cartesian motion has not been commissioned."
            : group === "perception" &&
                (!perception.configured ||
                  perception.cost_usd <= 0 ||
                  !perception.budget ||
                  perception.budget.spent_usd + perception.cost_usd >
                    perception.budget.limit_usd)
              ? "Perception requires a configured worker and sufficient approved budget."
              : group === "development" &&
                  !process.env["ROBO_PROGRAM_URL"] &&
                  config.host === "127.0.0.1" &&
                  !process.env["ROBO_PI_DEV_HOST"]
                ? "The development workspace API address is not configured."
                : null;
        if (unavailable)
          throw new ToolFailure({
            code: "CAPABILITY_UNAVAILABLE",
            detail: unavailable,
          });
        for (const toolName of groups[group]) enabled.add(toolName);
        return { available: groups[group], next_step: true };
      }
      if (name === "move_joints" || name === "move_cartesian") {
        const revision = options.steerRevision?.() ?? 0;
        const actionInput =
          name === "move_joints"
            ? decode(schemas.move_joints, input)
            : decode(schemas.move_cartesian, input);
        const id = `${options.runId}:${step}:${toolCallId}`;
        const owner = `action-${Bun.hash(id).toString(36)}-${options.runId}`;
        const result = await executor.execute({
          id,
          owner,
          input: actionInput,
          signal,
          progress: options.onProgress,
          assertCurrent: () => {
            if (revision !== (options.steerRevision?.() ?? 0))
              throw new ToolFailure({
                code: "OPERATOR_STEERED",
                detail:
                  "The operator changed the instruction before motion submission. Replan from the new instruction.",
              });
          },
        });
        if (result.status === "unknown" || result.status === "cancelled")
          motionDisabled = true;
        return result;
      }
      if (name === "observe") {
        // Model/tool initialization can outlive the sampler's cache window.
        // An explicit agent observation reads the motor service afresh and
        // still includes the full transport time in the 250 ms age bound.
        const observation = await robot.motionIO.observe(signal);
        if (observation.age_ms > 250)
          throw new ToolFailure({
            code: "UNSAFE_TARGET",
            detail:
              "Robot observation is stale after transport. Observe again before acting.",
          });
        return observation;
      }
      const output = await executeTool(name, input, options.principal, signal);
      if (name === "capture" || name === "recording_frame") {
        const frame = Schema.decodeUnknownSync(Frame)(output);
        if (options.vision) options.onImage(frame);
        const { base64: _base64, ...metadata } = frame;
        return {
          ...metadata,
          note:
            name === "recording_frame"
              ? "Archived recording frame. Do not use it as a current observation for motion."
              : options.vision
                ? "Image supplied in the next observation message."
                : "This model has no image input enabled. Do not infer object positions from this metadata.",
        };
      }
      return output;
    });
    const { outputSchema: _outputSchema, ...definitionWithInput } = definition;
    return definitionWithInput;
  });
  return {
    tools,
    prepare: (stepNumber: number, summaryOnly: boolean) => {
      step = stepNumber;
      offered = new Set(
        summaryOnly
          ? []
          : [...enabled].filter(
              (name) =>
                !(
                  (name === "move_joints" || name === "move_cartesian") &&
                  motionDisabled
                )
            )
      );
      return [...offered];
    },
  };
};
