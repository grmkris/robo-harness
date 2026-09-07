import type { Dispatch, SetStateAction } from "react";

import type { Recorded, Status } from "../lib/types";

export function RecordingsTab({
  recordName,
  setRecordName,
  recording,
  pending,
  fresh,
  run,
  records,
  onReplay,
}: {
  recordName: string;
  setRecordName: Dispatch<SetStateAction<string>>;
  recording: Status["recording"];
  pending: boolean;
  fresh: boolean;
  run: (name: string, input?: unknown) => Promise<unknown>;
  records: Recorded[];
  onReplay: (id: string) => void;
}) {
  return (
    <div className="tab-body">
      <p className="eyebrow">KEEP THE EVIDENCE</p>
      <h2>Record & revisit.</h2>
      <label htmlFor="record-name">Session label</label>
      <input
        id="record-name"
        value={recordName}
        onChange={(e) => setRecordName(e.target.value)}
      />
      <button
        className={recording ? "danger-outline" : "primary"}
        disabled={pending || (!recording && !fresh)}
        onClick={() => {
          void run(
            recording ? "recording_stop" : "recording_start",
            recording ? {} : { label: recordName }
          );
        }}
      >
        {recording
          ? `Stop recording · ${recording.frames} frames`
          : "Start recording"}
      </button>
      <div className="record-list">
        {records.map((r) => (
          <article key={r.id}>
            <div>
              <strong>{r.label}</strong>
              <small>
                {new Date(r.created).toLocaleString()} · {r.frames} frames
              </small>
              <span className="pill">{r.state}</span>
              {r.error ? <p className="error">{r.error}</p> : null}
            </div>
            <button
              onClick={() => {
                onReplay(r.id);
              }}
            >
              Replay ↗
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
