import type { AppEvent } from "@robo/domain";
import type { Dispatch, SetStateAction } from "react";

import type { Status } from "../lib/types";

export function PerceptionBar({
  settings,
  camera,
  setCamera,
  perceptionPrompt,
  setPerceptionPrompt,
  perceptionBusy,
  setPerceptionBusy,
  fresh,
  run,
  lastPerception,
}: {
  settings: Status["perception"];
  camera: string;
  setCamera: Dispatch<SetStateAction<string>>;
  perceptionPrompt: string;
  setPerceptionPrompt: Dispatch<SetStateAction<string>>;
  perceptionBusy: boolean;
  setPerceptionBusy: Dispatch<SetStateAction<boolean>>;
  fresh: boolean;
  run: (name: string, input?: unknown) => Promise<unknown>;
  lastPerception: AppEvent | undefined;
}) {
  return (
    <>
      <div className="perception-bar">
        <span className="eyebrow">LOOK CLOSER</span>
        <select
          aria-label="Perception camera"
          value={camera}
          onChange={(e) => setCamera(e.target.value)}
        >
          <option value="workspace">Workspace</option>
          <option value="wrist">Wrist</option>
        </select>
        <input
          aria-label="Segmentation prompt"
          value={perceptionPrompt}
          onChange={(e) => setPerceptionPrompt(e.target.value)}
          placeholder="Describe an object"
        />
        {(["segment", "depth"] as const).map((kind) => (
          <button
            key={kind}
            disabled={
              perceptionBusy || !fresh || !settings.capabilities[kind].ready
            }
            title={
              settings.capabilities[kind].reason ??
              settings.capabilities[kind].model
            }
            onClick={async () => {
              setPerceptionBusy(true);
              await run("perceive", {
                camera,
                kind,
                prompt: perceptionPrompt,
              });
              setPerceptionBusy(false);
            }}
          >
            {perceptionBusy
              ? "Working…"
              : kind === "segment"
                ? "Segment"
                : "Relative depth"}
          </button>
        ))}
      </div>
      <p className="perception-status">
        {(["segment", "depth"] as const).map((kind) => (
          <span key={kind}>
            <strong>{kind === "segment" ? "Segmentation" : "Depth"}</strong>:{" "}
            {settings.capabilities[kind].configured
              ? settings.capabilities[kind].model
              : "Not configured"}
            {settings.capabilities[kind].reason
              ? ` · ${settings.capabilities[kind].reason}`
              : ""}
            .{" "}
          </span>
        ))}
        Depth previews are relative, not measurements in meters.
      </p>
      {lastPerception ? (
        <a
          className="artifact-link"
          href={`/api/perception/${lastPerception.data["id"]}`}
          target="_blank"
          rel="noreferrer"
        >
          Open latest perception result ↗
        </a>
      ) : null}
    </>
  );
}
