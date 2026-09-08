import { RecordingArtifact, RecordingDetail } from "@robo/domain";
import { Schema } from "effect";
import { useState } from "react";

import { api } from "../lib/client";

export function RecordingEditor({
  initial,
  onClose,
}: {
  initial: RecordingDetail;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState(initial);
  const [task, setTask] = useState(initial.label);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(initial.duration_s);
  const [cursor, setCursor] = useState(0);
  const [outcome, setOutcome] = useState("unreviewed");
  const [intervention, setIntervention] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [camera, setCamera] = useState("both");
  const [overlay, setOverlay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const exportClip = async (kind: "mp4" | "lerobot") => {
    setBusy(true);
    setError("");
    try {
      const artifact = Schema.decodeUnknownSync(RecordingArtifact)(
        await api("tool/recording_export", {
          id: detail.id,
          kind,
          task,
          start_s: start,
          end_s: end,
          outcome,
          intervention,
          camera,
          speed: kind === "mp4" ? speed : 1,
          overlay: kind === "mp4" && overlay,
        })
      );
      if (artifact.state === "failed")
        setError(artifact.error ?? "Export failed");
      setDetail(
        Schema.decodeUnknownSync(RecordingDetail)(
          await api(`recordings/${detail.id}`)
        )
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };
  const trainingInterval = detail.quality.training_intervals.find(
    (interval) => start >= interval.start_s && end <= interval.end_s + 0.000001
  );
  const suggested = detail.quality.training_intervals[0];
  const invalid = busy || !task.trim() || end <= start || end - start > 300;
  return (
    <section className="recording-editor" aria-label="Recording editor">
      <div className="recording-editor-heading">
        <div>
          <p className="eyebrow">EXPERIMENT REVIEW</p>
          <h3>{detail.label}</h3>
        </div>
        <button type="button" onClick={onClose}>
          Close review
        </button>
      </div>
      <p className="recording-meta">
        {detail.duration_s.toFixed(1)} seconds · {detail.sampling_fps} Hz ·{" "}
        {detail.backend === "so101" ? "Real SO-101" : "Mock robot"} ·{" "}
        {detail.frames} samples
      </p>
      <div className="recording-preview">
        {["workspace", "wrist"].map((name) => (
          <figure key={name}>
            <img
              src={`/api/recordings/${detail.id}/frame?camera=${name}&time_s=${cursor}`}
              alt={`Recorded ${name} camera at ${cursor.toFixed(1)} seconds`}
            />
            <figcaption>
              {name} / {cursor.toFixed(1)}s
            </figcaption>
          </figure>
        ))}
      </div>
      <label htmlFor="recording-playhead">
        Review position · {cursor.toFixed(1)}s
      </label>
      <input
        id="recording-playhead"
        type="range"
        min={0}
        max={detail.duration_s}
        step={0.1}
        value={cursor}
        onChange={(event) => setCursor(Number(event.target.value))}
      />
      {detail.bookmarks.length ? (
        <details>
          <summary>{detail.bookmarks.length} task and action bookmarks</summary>
          <div className="recording-bookmarks">
            {detail.bookmarks.map((mark, index) => (
              <button
                type="button"
                key={`${mark.time_s}-${index}`}
                onClick={() => setCursor(mark.time_s)}
              >
                <time>{mark.time_s.toFixed(1)}s</time> {mark.text}
              </button>
            ))}
          </div>
        </details>
      ) : null}
      <div className="recording-interval">
        <label>
          From (seconds)
          <input
            type="number"
            min={0}
            max={end}
            step={0.1}
            value={start}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label>
          To (seconds)
          <input
            type="number"
            min={start}
            max={detail.duration_s}
            step={0.1}
            value={end}
            onChange={(event) => setEnd(Number(event.target.value))}
          />
        </label>
      </div>
      <label htmlFor="episode-task">Task instruction</label>
      <input
        id="episode-task"
        value={task}
        maxLength={200}
        onChange={(event) => setTask(event.target.value)}
      />
      <div className="recording-interval">
        <label>
          Observed outcome
          <select
            aria-label="Observed outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="unreviewed">Not reviewed</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        </label>
        <label>
          Video cameras
          <select
            aria-label="Video cameras"
            value={camera}
            onChange={(event) => setCamera(event.target.value)}
          >
            <option value="both">Both cameras</option>
            <option value="workspace">Workspace</option>
            <option value="wrist">Wrist</option>
          </select>
        </label>
      </div>
      <label className="recording-check">
        <input
          type="checkbox"
          checked={intervention}
          onChange={(event) => setIntervention(event.target.checked)}
        />
        Human intervention during this interval
      </label>
      <div className="recording-interval">
        <label>
          Video speed
          <select
            aria-label="Video speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            {[1, 2, 4, 8].map((value) => (
              <option value={value} key={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
        <label className="recording-check">
          <input
            type="checkbox"
            checked={overlay}
            onChange={(event) => setOverlay(event.target.checked)}
          />
          Show robot measurements
        </label>
      </div>
      <div className="recording-export-actions">
        <button
          type="button"
          className="primary"
          disabled={invalid}
          onClick={() => {
            void exportClip("mp4");
          }}
        >
          {busy ? "Exporting…" : "Create MP4"}
        </button>
        <button
          type="button"
          disabled={invalid || !trainingInterval}
          onClick={() => {
            void exportClip("lerobot");
          }}
        >
          Export LeRobot
        </button>
      </div>
      <p className="recording-meta">
        Largest camera/state offset:{" "}
        {detail.quality.max_camera_skew_ms.toFixed(0)} ms.{" "}
        {trainingInterval
          ? "This interval passes timing checks."
          : "Select an interval with aligned frames for training."}
      </p>
      {!trainingInterval && suggested ? (
        <button
          type="button"
          onClick={() => {
            setStart(suggested.start_s);
            setEnd(Math.min(suggested.end_s, suggested.start_s + 300));
            setCursor(suggested.start_s);
          }}
        >
          Use first interval with aligned frames
        </button>
      ) : null}
      <small>
        Exports keep your original recording. Training uses both cameras at the
        original speed. Select up to five minutes.
      </small>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="recording-downloads">
        {detail.exports.map((artifact) => (
          <div key={artifact.id}>
            {artifact.state === "completed" && artifact.url ? (
              <a href={artifact.url} download>
                {artifact.kind === "mp4"
                  ? "Download MP4"
                  : "Download LeRobot dataset"}{" "}
                ↗
              </a>
            ) : (
              <span>
                {artifact.kind} · {artifact.state}
              </span>
            )}
            <small>
              {artifact.task} · {artifact.outcome}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}
