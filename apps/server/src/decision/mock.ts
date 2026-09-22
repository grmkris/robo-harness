import type { EvaluateAdapter, WireAnswer } from "@tanstack/ai";

import type { Action } from "./candidates";
import { jevEvaluator, type Evaluator, type SpendMeter } from "./jev";
import type { SceneState } from "./scene-state";
import type { DecisionState } from "./state";
import { rulesChoice } from "./strategies";
import { rulesNext } from "./tactics";

/** Local transport; question and answer mapping still belongs to decide(). */
export const localAdapter = (
  evaluate: EvaluateAdapter["evaluate"]
): EvaluateAdapter => ({
  kind: "evaluate",
  name: "mock",
  model: "mock-jev",
  "~types": { providerOptions: {} },
  evaluate,
});

/**
 * Offline stand-in for Jev. Answers come from the rules baseline, but every
 * request still goes through the real TanStack `decide()` path
 * (question validation, answer normalisation). Results are labelled mock.
 */
// SAFETY: the mock only receives states built by decisionState in this module's callers.
const asState = (value: unknown) => value as DecisionState;
// SAFETY: the tactics mock only receives scenes built by buildScene.
const asScene = (value: unknown) => value as SceneState;

export const mockEvaluator =
  (meter: SpendMeter, offered: () => readonly Action[]): Evaluator =>
  (request) => {
    const evaluate: EvaluateAdapter["evaluate"] = (options) => {
      const state = asState(options.state);
      const choice = rulesChoice({
        state,
        offered: offered(),
        signal: request.signal,
      });
      const step = offered().find(
        (action) => action.id === choice && action.kind === "step"
      );
      const answers: Record<string, WireAnswer> = {};
      for (const [id, question] of Object.entries(options.questions)) {
        if (question.type === "noul") {
          const yes =
            id === "complete"
              ? state.task.reached
              : id === "act"
                ? Boolean(step)
                : state.freshness.usable && !state.robot.fault;
          answers[id] = { type: "noul", noul: yes ? 0.9 : 0.1 };
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
            confidence: 1,
            probabilities: Object.fromEntries(
              optionIds.map((option) => [
                option,
                option === picked ? 1 - rest * (optionIds.length - 1) : rest,
              ])
            ),
          };
        } else {
          answers[id] = {
            type: "score",
            score: 0,
            confidence: 1,
            legend: Object.fromEntries(
              question.criteria.map((label, index) => [String(index), label])
            ),
            probabilities: Object.fromEntries(
              question.criteria.map((_, index) => [
                String(index),
                index === 0 ? 1 : 0,
              ])
            ),
          };
        }
      }
      return Promise.resolve({
        answers,
        usage: {
          promptTokens: Math.round(JSON.stringify(options.state).length / 4),
          completionTokens: 0,
          totalTokens: Math.round(JSON.stringify(options.state).length / 4),
        },
        model: "mock-jev",
      });
    };
    return jevEvaluator({
      adapter: localAdapter(evaluate),
      meter,
    })(request);
  };

/** Offline stand-in for the skill tactician: rules answers through the real evaluate path. */
export const mockTacticsEvaluator = (meter: SpendMeter): Evaluator =>
  jevEvaluator({
    meter,
    adapter: localAdapter((options) => {
      const scene = asScene(options.state);
      return Promise.resolve({
        answers: {
          next_skill: {
            type: "choice",
            choice: rulesNext(scene),
            confidence: 1,
            probabilities: { [rulesNext(scene)]: 1 },
          },
          grasp_ready: {
            type: "noul",
            noul: scene.observed.tip.at_grasp_height ? 0.8 : 0.1,
          },
          risk: {
            type: "score",
            score: 0.2,
            confidence: 1,
            legend: { "0": "clear", "1": "tight", "2": "about to go wrong" },
            probabilities: { "0": 0.8, "1": 0.2, "2": 0 },
          },
          piece_held: {
            type: "noul",
            noul: scene.observed.gripper.holding ? 0.9 : 0.05,
          },
        },
        usage: {
          promptTokens: Math.round(JSON.stringify(options.state).length / 4),
          completionTokens: 0,
          totalTokens: Math.round(JSON.stringify(options.state).length / 4),
        },
        model: "mock-jev",
      });
    }),
  });
