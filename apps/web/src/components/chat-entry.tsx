import { ChatCapture, Operation, joints, type AppEvent } from "@robo/domain";
import { Schema } from "effect";
import { useState } from "react";

import { label, time } from "../lib/client";

const MotionResult = Schema.Struct({ operation: Schema.NullOr(Operation) });

function CaptureImage({ capture }: { capture: ChatCapture }) {
  const [failed, setFailed] = useState(false);
  const url = `/api/chat-images/${capture.image_id}`;
  return (
    <figure className="chat-capture">
      {failed ? (
        <p>Saved image unavailable.</p>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title="Open full-size capture"
        >
          <img
            src={url}
            alt={`${capture.camera} capture`}
            width={capture.width}
            height={capture.height}
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
      )}
      <figcaption>
        <span>
          {capture.camera}
          {capture.archived ? " · recording" : " · captured"}
        </span>
        <time
          title={`Frame ${capture.seq} · ${Math.round(capture.age_ms)} ms old at capture`}
        >
          {time(capture.wall_time_ms)}
        </time>
      </figcaption>
    </figure>
  );
}

export function ChatToolEntry({
  event,
  result,
  running,
}: {
  event: AppEvent;
  result: AppEvent | undefined;
  running: boolean;
}) {
  const output = result?.data["output"] ?? event.data["output"];
  const decoded = Schema.decodeUnknownOption(ChatCapture)(output);
  const capture = decoded._tag === "Some" ? decoded.value : null;
  const failed = (result ?? event).type === "chat.tool_error";
  const name = String(event.data["name"]);
  const outcome = result ?? (event.type === "chat.tool" ? undefined : event);
  return (
    <article className={`chat-event chat-tool ${failed ? "chat-failure" : ""}`}>
      <details>
        <summary>
          <span>
            {label(name)}
            {capture ? ` · ${capture.camera}` : ""}
          </span>
          <span className="tool-state">
            {failed
              ? "Failed"
              : outcome
                ? "Returned"
                : running
                  ? "Running…"
                  : "No result"}
          </span>
          <time>{time(event.time)}</time>
        </summary>
        {event.data["input"] === undefined ? null : (
          <pre>{JSON.stringify(event.data["input"], null, 2)}</pre>
        )}
        {output === undefined ? null : (
          <pre>{JSON.stringify(output, null, 2)}</pre>
        )}
      </details>
      {failed ? <p role="alert">{String(outcome?.data["message"])}</p> : null}
      {capture ? <CaptureImage capture={capture} /> : null}
      {!capture &&
      outcome?.type === "chat.tool_result" &&
      ["capture", "recording_frame"].includes(name) ? (
        <p className="muted">Image was not saved in this older conversation.</p>
      ) : null}
    </article>
  );
}

export function ChatMotionEntry({ event }: { event: AppEvent }) {
  const result = Schema.decodeUnknownOption(MotionResult)(event.data["result"]);
  const operation = result._tag === "Some" ? result.value.operation : null;
  const measured = operation?.measured;
  return (
    <article className="chat-event motion-progress">
      <small>
        Motion <time>{time(event.time)}</time>
      </small>
      <p>{String(event.data["message"] ?? "")}</p>
      {operation && measured ? (
        <details>
          <summary>Target and measured position</summary>
          <table>
            <thead>
              <tr>
                <th>Joint</th>
                <th>Target</th>
                <th>Measured</th>
              </tr>
            </thead>
            <tbody>
              {joints.map((joint) => (
                <tr key={joint}>
                  <th>{label(joint)}</th>
                  <td>{operation.target[joint].toFixed(2)}</td>
                  <td>
                    {measured[joint].toFixed(2)}
                    {joint === "gripper" ? "%" : "°"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </article>
  );
}
