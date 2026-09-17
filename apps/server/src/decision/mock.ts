import type {
  Experimental_EvaluationModelV4Answer,
  Experimental_EvaluationModelV4CallOptions,
} from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4 } from "ai/test";

import type { Action } from "./candidates";
import { jevEvaluator, type Evaluator, type SpendMeter } from "./jev";
import type { SceneState } from "./scene-state";
import type { DecisionState } from "./state";
import { rulesChoice } from "./strategies";
import { rulesNext } from "./tactics";

/**
 * Offline stand-in for Jev. Answers come from the rules baseline, but every
 * request still goes through the real AI SDK `experimental_evaluate` path
 * (question validation, answer normalisation). Results are labelled mock.
 */
// SAFETY: the mock only receives states built by decisionState in this module's callers.
const asState = (value: unknown) => value as DecisionState;
// SAFETY: the tactics mock only receives scenes built by buildScene.
const asScene = (value: unknown) => value as SceneState;

export const mockEvaluator =
  (meter: SpendMeter, offered: () => readonly Action[]): Evaluator =>
  (request) => {
    const doEvaluate = (options: Experimental_EvaluationModelV4CallOptions) => {
      const state = asState(options.state);
      const choice = rulesChoice({
        state,
        offered: offered(),
        signal: request.signal,
      });
      const step = offered().find(
        (action) => action.id === choice && action.kind === "step"
      );
      const answers: Record<string, Experimental_EvaluationModelV4Answer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        if (question.type === "boolean") {
          const yes =
            id === "complete"
              ? state.task.reached
              : id === "act"
                ? Boolean(step)
                : state.freshness.usable && !state.robot.fault;
          answers[id] = { type: "boolean", probability: yes ? 0.9 : 0.1 };
        } else if (question.type === "choice") {
          const optionIds = Object.keys(question.criteria);
          const preferred =
            id === "terminate"
              ? ["done", "stop"].includes(choice)
                ? choice
                : "continue"
              : id === "joint"
                ? step && "joint" in step
                  ? step.joint
                  : optionIds[0]
                : id === "direction"
                  ? step && "delta" in step && step.delta < 0
                    ? "decrease"
                    : "increase"
                  : choice;
          const picked = optionIds.includes(preferred ?? "")
            ? (preferred ?? "")
            : (optionIds[0] ?? "");
          const rest = optionIds.length > 1 ? 0.1 / (optionIds.length - 1) : 0;
          answers[id] = {
            type: "choice",
            choice: picked,
            probabilities: Object.fromEntries(
              optionIds.map((option) => [
                option,
                option === picked ? 1 - rest * (optionIds.length - 1) : rest,
              ])
            ),
          };
        } else {
          answers[id] = { type: "score", score: 0 };
        }
      }
      return Promise.resolve({
        answers,
        usage: {
          inputTokens: Math.round(JSON.stringify(options.state).length / 4),
          outputTokens: 0,
        },
        warnings: [],
        response: { modelId: "mock-jev" },
      });
    };
    return jevEvaluator({
      model: new Experimental_EvaluationMockModelV4({
        provider: "mock",
        modelId: "mock-jev",
        supportedQuestionTypes: ["choice", "score", "boolean"],
        doEvaluate,
      }),
      meter,
    })(request);
  };

/** Offline stand-in for the skill tactician: rules answers through the real evaluate path. */
export const mockTacticsEvaluator = (meter: SpendMeter): Evaluator =>
  jevEvaluator({
    meter,
    model: new Experimental_EvaluationMockModelV4({
      provider: "mock",
      modelId: "mock-jev",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doEvaluate: (options) => {
        const scene = asScene(options.state);
        return Promise.resolve({
          answers: {
            next_skill: { type: "choice", choice: rulesNext(scene) },
            grasp_ready: {
              type: "boolean",
              probability: scene.observed.tip.at_grasp_height ? 0.8 : 0.1,
            },
            risk: { type: "score", score: 0.2 },
            piece_held: {
              type: "boolean",
              probability: scene.observed.gripper.holding ? 0.9 : 0.05,
            },
          },
          usage: {
            inputTokens: Math.round(JSON.stringify(options.state).length / 4),
            outputTokens: 0,
          },
          warnings: [],
          response: { modelId: "mock-jev" },
        });
      },
    }),
  });
