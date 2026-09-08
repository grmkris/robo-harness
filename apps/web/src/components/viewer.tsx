import type { Observation } from "@robo/domain";
import type { ReactNode } from "react";

import type { Status } from "../lib/types";

export function Viewer({
  review,
  recording,
  recordingPending,
  canRecord,
  onRecord,
  replay,
  fallback,
  viewerKey,
  viewerUrl,
  viewTick,
  obs,
  telemetry,
  clockUncertaintyMs,
  onReturnLive,
  onToggleFallback,
  onReload,
}: {
  review: ReactNode;
  recording: Status["recording"];
  recordingPending: boolean;
  canRecord: boolean;
  onRecord: () => Promise<void>;
  replay: string | null;
  fallback: boolean;
  viewerKey: number;
  viewerUrl: string;
  viewTick: number;
  obs: Observation | null | undefined;
  telemetry: Status["telemetry"];
  clockUncertaintyMs: number;
  onReturnLive: () => void;
  onToggleFallback: () => void;
  onReload: () => void;
}) {
  return (
    <>
      <div className="panel-head">
        <div className="panel-heading">
          <span className="eyebrow">01 / OBSERVATION</span>
          <strong>{replay ? "Recorded session" : "Live workspace"}</strong>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className={recording ? "danger-outline" : "primary"}
            disabled={recordingPending || (!recording && !canRecord)}
            onClick={() => {
              void onRecord();
            }}
          >
            {recording
              ? `● REC ${Math.floor((Date.now() - recording.created) / 60_000)}:${String(Math.floor((Date.now() - recording.created) / 1000) % 60).padStart(2, "0")} · Stop recording`
              : "⏺ Record"}
          </button>
          {replay ? (
            <button onClick={onReturnLive}>Return to live</button>
          ) : null}
          <button aria-pressed={fallback} onClick={onToggleFallback}>
            {fallback ? "Rerun view" : "Camera view"}
          </button>
          <button aria-label="Reload visualization" onClick={onReload}>
            ↻
          </button>
        </div>
      </div>
      {review ?? (
        <>
          <div className="viewer-shell">
            {fallback || !telemetry.online || telemetry.error ? (
              <div className="camera-fallback">
                <div className="camera-grid">
                  {["workspace", "wrist"].map((name) => (
                    <figure key={name}>
                      <img
                        src={`/api/cameras/${name}?t=${viewTick}`}
                        alt={`${name} camera`}
                        onError={(e) => {
                          e.currentTarget.style.opacity = ".3";
                        }}
                        onLoad={(e) => {
                          e.currentTarget.style.opacity = "1";
                        }}
                      />
                      <figcaption>
                        {name}
                        <span>
                          {Math.round(obs?.cameras[name]?.age_ms ?? 0)} ms
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                {fallback ? null : (
                  <div className="viewer-notice">
                    <strong>Rerun is reconnecting</strong>
                    <span>
                      {telemetry.error ??
                        "Waiting for the telemetry worker. Live cameras remain available."}
                    </span>
                  </div>
                )}
                <div className="pose-readout">
                  <span>END EFFECTOR / BASE FRAME</span>
                  {obs?.ee.map((v, i) => (
                    <span key={i}>
                      {["X", "Y", "Z"][i]} <b>{v.toFixed(3)}</b> m
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <iframe
                key={viewerKey}
                src={viewerUrl}
                title="Rerun robot visualization"
                className="rerun-frame"
                allow="fullscreen"
              />
            )}
            <div className={`view-label ${replay ? "history" : ""}`}>
              <span className="led" />
              {replay
                ? "HISTORICAL RECORDING"
                : "LIVE FEED · VIEWER TIMELINE CAN BE PAUSED"}
              <span>Controls always use current state</span>
            </div>
          </div>
          <div className="visual-footer">
            <span>RERUN {telemetry.version || "0.30.1"}</span>
            <span>Clock uncertainty ±{Math.round(clockUncertaintyMs)} ms</span>
            <span>{telemetry.dropped} skipped preview samples</span>
          </div>
        </>
      )}
    </>
  );
}
