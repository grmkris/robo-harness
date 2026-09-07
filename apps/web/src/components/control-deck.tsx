import { joints } from "@robo/domain";
import type { Observation } from "@robo/domain";
import type { Dispatch, SetStateAction } from "react";

import { label } from "../lib/client";
import { MoveIcon } from "./icons";

export function ControlDeck({
  obs,
  fresh,
  own,
  pending,
  activeMove,
  run,
  halt,
  jogStep,
  setJogStep,
  cartStep,
  setCartStep,
  moveJoint,
  moveCartesian,
}: {
  obs: Observation | null | undefined;
  fresh: boolean;
  own: boolean;
  pending: boolean;
  activeMove: boolean;
  run: (name: string, input?: unknown) => Promise<unknown>;
  halt: () => Promise<void>;
  jogStep: number;
  setJogStep: Dispatch<SetStateAction<number>>;
  cartStep: number;
  setCartStep: Dispatch<SetStateAction<number>>;
  moveJoint: (j: (typeof joints)[number], delta: number) => Promise<void>;
  moveCartesian: (axis: number, delta: number) => Promise<void>;
}) {
  return (
    <section className="control-deck panel">
      <div className="control-header">
        <div className="panel-heading">
          <span className="eyebrow">02 / CONTROL</span>
          <strong>
            <MoveIcon />{" "}
            {obs?.operator
              ? `${label(obs.operator.mode)} control`
              : "Holding position"}
          </strong>
        </div>
        <div className="toolbar">
          <span className="owner-label">
            {obs?.operator?.owner?.startsWith("browser-")
              ? "Your browser"
              : (obs?.operator?.owner ?? "No active controller")}
          </span>
          <button
            disabled={pending || !fresh}
            onClick={() => {
              void run("acquire", { mode: "human", takeover: true });
            }}
          >
            Take manual control
          </button>
          <button
            disabled={pending || !fresh || obs?.backend === "mock"}
            onClick={() => {
              void run("acquire", { mode: "leader", takeover: true });
            }}
          >
            Use leader arm
          </button>
          <button
            disabled={!own || pending}
            onClick={() => {
              void run("release");
            }}
          >
            Release
          </button>
          <button
            className="stop-button"
            onClick={() => {
              void halt();
            }}
          >
            ■ STOP / HOLD
          </button>
        </div>
      </div>
      <div className="joint-grid">
        {joints.map((j, i) => (
          <div className="joint" key={j}>
            <div className="joint-name">
              <span>0{i + 1}</span>
              {label(j)}
            </div>
            <div className="joint-value">
              {obs?.measured[j].toFixed(1) ?? "—"}
              <small>{j === "gripper" ? "%" : "°"}</small>
            </div>
            <div className="joint-track">
              <span
                style={{
                  left: obs
                    ? `${Math.max(
                        0,
                        Math.min(
                          100,
                          ((obs.measured[j] - obs.limits[j][0]) /
                            (obs.limits[j][1] - obs.limits[j][0])) *
                            100
                        )
                      )}%`
                    : "50%",
                }}
              />
            </div>
            <div className="joint-jog">
              <button
                aria-label={`Decrease ${label(j)}`}
                disabled={
                  !own ||
                  !fresh ||
                  pending ||
                  activeMove ||
                  obs?.operator?.mode === "leader"
                }
                onClick={() => {
                  void moveJoint(j, -jogStep);
                }}
              >
                −
              </button>
              <span>
                ±{jogStep}
                {j === "gripper" ? "%" : "°"}
              </span>
              <button
                aria-label={`Increase ${label(j)}`}
                disabled={
                  !own ||
                  !fresh ||
                  pending ||
                  activeMove ||
                  obs?.operator?.mode === "leader"
                }
                onClick={() => {
                  void moveJoint(j, jogStep);
                }}
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="cartesian">
        <div>
          <span className="eyebrow">CARTESIAN / BASE FRAME</span>
          <small>Position-only IK · meters</small>
        </div>
        {["X", "Y", "Z"].map((axis, i) => (
          <div className="cart-axis" key={axis}>
            <b>{axis}</b>
            <button
              aria-label={`Decrease Cartesian ${axis}`}
              disabled={
                !own ||
                !fresh ||
                pending ||
                activeMove ||
                !obs?.cartesian ||
                obs?.operator?.mode === "leader"
              }
              onClick={() => {
                void moveCartesian(i, -cartStep);
              }}
            >
              −
            </button>
            <span>{obs?.ee[i]?.toFixed(3) ?? "—"}</span>
            <button
              aria-label={`Increase Cartesian ${axis}`}
              disabled={
                !own ||
                !fresh ||
                pending ||
                activeMove ||
                !obs?.cartesian ||
                obs?.operator?.mode === "leader"
              }
              onClick={() => {
                void moveCartesian(i, cartStep);
              }}
            >
              +
            </button>
          </div>
        ))}
        <label>
          Step{" "}
          <select
            aria-label="Cartesian step"
            value={cartStep}
            onChange={(e) => setCartStep(Number(e.target.value))}
          >
            <option value={0.001}>1 mm</option>
            <option value={0.005}>5 mm</option>
            <option value={0.01}>10 mm</option>
          </select>
        </label>
        <label>
          Joint{" "}
          <select
            aria-label="Joint step"
            value={jogStep}
            onChange={(e) => setJogStep(Number(e.target.value))}
          >
            <option value={1}>1° / %</option>
            <option value={2}>2° / %</option>
            <option value={5}>5° / %</option>
          </select>
        </label>
      </div>
    </section>
  );
}
