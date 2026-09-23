import type { Frame } from "@robo/domain";
import { Schema } from "effect";

import { decode } from "./decode";
import {
  loadManipulationConfig,
  pixelToTable,
  type ManipulationConfig,
} from "./manipulation-config";
import { manipulationMotion } from "./manipulation-motion";
import { cropFrame, requireFreshFrame } from "./manipulation-vision";
import type { MotionProgress } from "./motion-actions";
import { motionExecutor } from "./motion-executor";
import { perceive, perceptionConfig } from "./perception";
import * as robot from "./robot";
import { ToolFailure } from "./tool-errors";

const Camera = Schema.Literals(["workspace", "wrist"]);
const Pixel = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Size = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }));
const Metres = Schema.Finite.check(
  Schema.isBetween({ minimum: -0.5, maximum: 0.5 })
);
export const manipulationSchemas = {
  look: Schema.Struct({
    camera: Schema.optionalKey(Camera),
    crop: Schema.optionalKey(
      Schema.Struct({ x: Pixel, y: Pixel, width: Size, height: Size })
    ),
  }),
  locate: Schema.Struct({
    camera: Camera,
    description: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(200)
    ),
  }),
  move_tcp: Schema.Struct({ x: Metres, y: Metres, z: Metres }),
  move_tcp_by: Schema.Struct({ dx: Metres, dy: Metres, dz: Metres }),
  descend_until_contact: Schema.Struct({
    max_dz: Schema.Finite.check(
      Schema.isBetween({ minimum: 0.001, maximum: 0.15 })
    ),
  }),
  set_wrist_roll: Schema.Struct({
    deg: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
  }),
  gripper: Schema.Struct({
    percent: Schema.Finite.check(
      Schema.isBetween({ minimum: 0, maximum: 100 })
    ),
  }),
  home: Schema.Struct({}),
};
type Name = keyof typeof manipulationSchemas;
export const manipulationMotionNames = new Set<string>([
  "move_tcp",
  "move_tcp_by",
  "descend_until_contact",
  "set_wrist_roll",
  "gripper",
  "home",
]);
export const isManipulationTool = (name: string): name is Name =>
  Object.hasOwn(manipulationSchemas, name);
export const manipulationDescriptions: Record<Name, string> = {
  look: "Look at fresh workspace and wrist frames, or select one camera. Optional crop is {x,y,width,height} in source pixels, automatically enlarged up to 4x. Source-to-crop mapping is returned. Images are supplied with the next observation.",
  locate:
    "Segment a described object or surface in a fresh camera frame using SAM-3 within the approved perception budget. Returns source-pixel boxes and table-plane XY estimates for calibrated workspace pixels. Raised surfaces have parallax error. If unavailable, use look and read the image.",
  move_tcp:
    "Move the calibrated TCP to {x,y,z} in base_link metres, pointing down, in small Cartesian segments. The entire path and every joint step are fenced to the safe area. Returns measured pose and residual. Stops on the first failed step.",
  move_tcp_by:
    "Move the calibrated TCP by {dx,dy,dz} metres in base_link, pointing down. Returns measured TCP and residual. Stops on the first failed step.",
  descend_until_contact:
    "Descend by at most max_dz metres in 3 mm steps. Stop at the first failed step; contact=true means a non-settling motion, not proof of what was touched. Inspect fresh images before continuing.",
  set_wrist_roll:
    "Rotate jaws to absolute wrist_roll deg within reviewed limits. Returns measured angle and residual; use only with visible clearance.",
  gripper:
    "Open or close to percent (0 closed, 100 open). Returns measured opening and stalled_at if resistance stops the jaws. Resistance alone does not prove a grasp; verify with images.",
  home: "Raise and return the TCP to the commissioned home position with at least 5 cm table clearance. Holds the current gripper opening.",
};

interface Options {
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  onImage: (frame: Frame) => string;
  onProgress: (progress: MotionProgress) => void;
  assertCurrent: () => void;
  onUnsafeOutcome: () => void;
  config: ManipulationConfig | null;
}
export const manipulationSnapshot = () => {
  const loaded = loadManipulationConfig();
  return loaded.status === "loaded" ? loaded.config : null;
};

export const executeManipulationTool = async (
  name: Name,
  input: unknown,
  options: Options
): Promise<unknown> => {
  const capture = async (camera: string) => {
    const started = performance.now();
    try {
      const frame = await robot.capture(camera);
      return requireFreshFrame({
        ...frame,
        age_ms: frame.age_ms + performance.now() - started,
      });
    } catch (error) {
      if (
        error instanceof robot.ApiError &&
        /stale|unavailable/iu.test(error.message)
      ) {
        throw new ToolFailure({
          code: "TRANSIENT_CAMERA",
          detail: camera + " camera unavailable. Wait and look again.",
        });
      }
      throw error;
    }
  };
  const image = (frame: Frame) => {
    const imageId = options.onImage(frame);
    const { base64: _base64, ...metadata } = frame;
    return { ...metadata, image_id: imageId, archived: false };
  };
  if (name === "look") {
    const value = decode(manipulationSchemas.look, input);
    const cameras = value.camera ? [value.camera] : ["workspace", "wrist"];
    const frames = await Promise.all(cameras.map(capture));
    return {
      frames: frames.map((frame) => image(cropFrame(frame, value.crop))),
    };
  }
  if (name === "locate") {
    const value = decode(manipulationSchemas.locate, input);
    const frame = await capture(value.camera);
    const view = image(frame);
    if (!perceptionConfig().capabilities.segment.ready) {
      return {
        available: false,
        frame: view,
        note: "Segmentation unavailable or budget exhausted. Read the supplied image; no metric target is inferred.",
      };
    }
    const result = await perceive(
      {
        camera: value.camera,
        kind: "segment",
        prompt: value.description,
        frame_id: frame.id,
      },
      options.signal
    );
    return {
      available: true,
      frame: view,
      perception_id: result.id,
      model: result.model,
      objects: (result.masks ?? []).map((mask) => {
        const bounds = mask.bounds_pixels;
        const center =
          bounds && bounds.length === 4
            ? ([
                ((bounds[0] ?? 0) + (bounds[2] ?? 0)) / 2,
                ((bounds[1] ?? 0) + (bounds[3] ?? 0)) / 2,
              ] as const)
            : null;
        return {
          bounds_pixels: bounds,
          score: mask.score ?? null,
          center_pixels: center,
          table_xy_m:
            center && value.camera === "workspace"
              ? pixelToTable(
                  options.config?.workspace_table_homography ?? null,
                  center[0],
                  center[1]
                )
              : null,
        };
      }),
      note: "Table XY applies only to the table plane; raised objects have parallax. Inspect before motion.",
    };
  }
  const config = options.config;
  if (!config)
    throw new ToolFailure({
      code: "CAPABILITY_UNAVAILABLE",
      detail: "Manipulation configuration is absent or invalid.",
    });
  const sequenceId = options.runId + ":" + options.toolCallId;
  let move = 0;
  const motion = manipulationMotion(config, {
    signal: options.signal,
    observe: () => robot.motionIO.observe(options.signal),
    move: async (target, durationS) => {
      options.assertCurrent();
      const id =
        options.runId + ":" + options.toolCallId + ":" + String(move++);
      const result = await motionExecutor.execute({
        id,
        sequenceId,
        owner: "manip-" + Bun.hash(id).toString(36),
        input: { target, duration_s: durationS },
        signal: options.signal,
        progress: options.onProgress,
        assertCurrent: options.assertCurrent,
      });
      if (
        result.status === "unknown" ||
        (result.status === "cancelled" &&
          !/camera.*stale|camera.*unavailable|control loop deadline missed/iu.test(
            result.message
          ))
      )
        options.onUnsafeOutcome();
      return {
        status: result.status,
        after: await robot.motionIO.observe(options.signal).catch(() => null),
        message: result.message,
      };
    },
  });
  return motionExecutor.withSequence(sequenceId, async () => {
    switch (name) {
      case "move_tcp": {
        const v = decode(manipulationSchemas.move_tcp, input);
        return motion.moveTcp([v.x, v.y, v.z]);
      }
      case "move_tcp_by": {
        const v = decode(manipulationSchemas.move_tcp_by, input);
        return motion.moveTcp([v.dx, v.dy, v.dz], true);
      }
      case "descend_until_contact": {
        return motion.descend(
          decode(manipulationSchemas.descend_until_contact, input).max_dz
        );
      }
      case "set_wrist_roll": {
        return motion.roll(
          decode(manipulationSchemas.set_wrist_roll, input).deg
        );
      }
      case "gripper": {
        return motion.grip(decode(manipulationSchemas.gripper, input).percent);
      }
      case "home": {
        return motion.home();
      }
    }
  });
};
