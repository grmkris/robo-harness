import type { Frame, Observation } from "@robo/domain";

import { whiteBlob } from "./blob";
import { describeScene, type SceneConfig } from "./scene";
import type { Detection } from "./state";

export interface PerceptionOptions {
  readonly capture: (camera: string) => Promise<Frame>;
  /** Optional slow describer; runs on the first step and then every `sceneEvery` steps. */
  readonly scene: SceneConfig | null;
  readonly sceneEvery: number;
}

/**
 * Pickup perception: a local wrist blob every step, a grasp heuristic from
 * the gripper feedback, and an optional big-model scene description at a
 * lower rate. Everything is text; images never reach the decision model.
 */
export const pickupPerception = (options: PerceptionOptions) => {
  let step = 0;
  let lastScene: Detection | null = null;
  const perceive = async (
    obs: Observation,
    signal: AbortSignal
  ): Promise<readonly Detection[]> => {
    step += 1;
    const detections: Detection[] = [];
    let wrist: Frame | null = null;
    try {
      wrist = await options.capture("wrist");
      detections.push(whiteBlob(wrist));
    } catch (error) {
      detections.push({
        source: "white-blob/v1",
        camera: "wrist",
        frame_age_ms: null,
        visible: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 120)
            : "capture failed",
      });
    }
    // Closing on an object stalls the gripper short of its command.
    const blocked = obs.commanded.gripper - obs.measured.gripper;
    detections.push({
      source: "grasp-check/v1",
      camera: "none",
      frame_age_ms: null,
      gripper_measured: Math.round(obs.measured.gripper * 10) / 10,
      gripper_commanded: Math.round(obs.commanded.gripper * 10) / 10,
      closing_blocked_by: Math.round(-blocked * 10) / 10,
      likely_holding: obs.measured.gripper - obs.commanded.gripper >= 3,
    });
    if (
      options.scene &&
      wrist &&
      (lastScene === null || step % options.sceneEvery === 0)
    ) {
      try {
        const workspace = await options.capture("workspace");
        lastScene = await describeScene(
          options.scene,
          [workspace, wrist],
          signal
        );
      } catch {
        lastScene = {
          source: `scene/${options.scene.model}`,
          camera: "workspace+wrist",
          frame_age_ms: null,
          ok: false,
        };
      }
    }
    if (lastScene) detections.push({ ...lastScene, described_at_step: step });
    return detections;
  };
  return { perceive };
};
