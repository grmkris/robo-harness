import { RecordingDetail } from "@robo/domain";
import { Schema } from "effect";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { api } from "../lib/client";
import type { Recorded, Status } from "../lib/types";
import { PerceptionHistory } from "./perception-review";
import { RecordingEditor } from "./recording-editor";

export function RecordingsTab({
  perceptionRevision,
  reviewId,
  onPerception,
  recordName,
  setRecordName,
  recording,
  pending,
  fresh,
  run,
  records,
  onReplay,
}: {
  perceptionRevision: number;
  reviewId: string | null;
  onPerception: (id: string) => void;
  recordName: string;
  setRecordName: Dispatch<SetStateAction<string>>;
  recording: Status["recording"];
  pending: boolean;
  fresh: boolean;
  run: (name: string, input?: unknown) => Promise<unknown>;
  records: Recorded[];
  onReplay: (id: string) => void;
}) {
  const [selected, setSelected] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    if (reviewId)
      void api(`recordings/${reviewId}`)
        .then((raw) => {
          if (current)
            setSelected(Schema.decodeUnknownSync(RecordingDetail)(raw));
        })
        .catch((error) => {
          if (current) setError(String(error));
        });
    return () => {
      current = false;
    };
  }, [reviewId]);
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
      <p className="recording-meta">
        Both cameras, joint measurements, commands and events. Stop to review,
        make a video, or export a training episode.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {selected ? (
        <RecordingEditor
          key={selected.id}
          initial={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {selected ? (
        <PerceptionHistory
          revision={perceptionRevision}
          recordingId={selected.id}
          recordingCreated={
            records.find((record) => record.id === selected.id)?.created
          }
          onSelect={onPerception}
        />
      ) : null}
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
              type="button"
              disabled={r.state === "recording"}
              onClick={async () => {
                try {
                  setError("");
                  setSelected(
                    Schema.decodeUnknownSync(RecordingDetail)(
                      await api(`recordings/${r.id}`)
                    )
                  );
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Could not load recording"
                  );
                }
              }}
            >
              Review & export
            </button>
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
