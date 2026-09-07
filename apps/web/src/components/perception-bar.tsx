import type { AppEvent } from "@robo/domain";
import type { Dispatch, SetStateAction } from "react";

export function PerceptionBar({
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
            disabled={perceptionBusy || !fresh}
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
                : "Estimate depth"}
          </button>
        ))}
      </div>
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
