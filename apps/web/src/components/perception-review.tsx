import {
  PerceptionDetail,
  PerceptionPage,
  type PerceptionCheck,
} from "@robo/domain";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { api } from "../lib/client";

function MaskLayer({
  detail,
  opacity,
  outlines,
}: {
  detail: PerceptionDetail;
  opacity: number;
  outlines: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let disposed = false;
    const node = canvas.current;
    if (!node) return;
    const context = node.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, node.width, node.height);
    const colors = [
      [92, 224, 163],
      [255, 193, 93],
      [123, 185, 255],
    ];
    const draw = async () => {
      const layers = await Promise.all(
        (detail.result?.masks ?? []).map(async (mask, index) => {
          const image = new Image();
          image.src = `data:image/png;base64,${mask.png}`;
          await image.decode();
          const scratch = document.createElement("canvas");
          scratch.width = node.width;
          scratch.height = node.height;
          const ctx = scratch.getContext("2d");
          if (!ctx) return null;
          ctx.drawImage(image, 0, 0, node.width, node.height);
          const pixels = ctx.getImageData(0, 0, node.width, node.height);
          const input = pixels.data;
          const output = ctx.createImageData(node.width, node.height);
          const inside = (x: number, y: number) =>
            x >= 0 &&
            y >= 0 &&
            x < node.width &&
            y < node.height &&
            (input[(y * node.width + x) * 4 + 3] ?? 0) > 0 &&
            Math.max(
              input[(y * node.width + x) * 4] ?? 0,
              input[(y * node.width + x) * 4 + 1] ?? 0,
              input[(y * node.width + x) * 4 + 2] ?? 0
            ) > 0;
          const color = colors[index % colors.length]!;
          for (let y = 0; y < node.height; y++)
            for (let x = 0; x < node.width; x++) {
              if (!inside(x, y)) continue;
              const edge =
                outlines &&
                (!inside(x - 1, y) ||
                  !inside(x + 1, y) ||
                  !inside(x, y - 1) ||
                  !inside(x, y + 1));
              const at = (y * node.width + x) * 4;
              output.data.set(
                [
                  color[0]!,
                  color[1]!,
                  color[2]!,
                  edge ? 255 : Math.round(opacity * 255),
                ],
                at
              );
            }
          ctx.putImageData(output, 0, 0);
          return scratch;
        })
      );
      if (disposed) return;
      for (const layer of layers) if (layer) context.drawImage(layer, 0, 0);
    };
    void draw().catch(() => {
      if (!disposed) context.clearRect(0, 0, node.width, node.height);
    });
    return () => {
      disposed = true;
    };
  }, [detail, opacity, outlines]);
  return (
    <canvas
      ref={canvas}
      width={detail.check.width}
      height={detail.check.height}
      className="perception-layer"
      aria-label="Segmentation mask overlay"
    />
  );
}
export function PerceptionReview({
  id,
  onClose,
  viewTick = 0,
  revision = 0,
}: {
  id: string;
  onClose: () => void;
  viewTick?: number;
  revision?: number;
}) {
  const [detail, setDetail] = useState<PerceptionDetail | null>(null);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(true);
  const [opacity, setOpacity] = useState(0.35);
  const [outlines, setOutlines] = useState(true);
  useEffect(() => {
    let current = true;
    setDetail(null);
    setError("");
    void api(`perception/${id}/detail`)
      .then((raw) => {
        if (current) setDetail(Schema.decodeUnknownSync(PerceptionDetail)(raw));
      })
      .catch((error) => {
        if (current) setError(String(error));
      });
    return () => {
      current = false;
    };
  }, [id, revision]);
  return (
    <section className="perception-review" aria-label="Perception review">
      <div className="perception-review-head">
        <span className="eyebrow">ANALYZED FRAME · HISTORICAL</span>
        <button type="button" onClick={onClose}>
          Return to live
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : detail === null ? (
        <p>Loading check…</p>
      ) : (
        <>
          <div className="perception-review-title">
            <strong>{detail.check.prompt}</strong>
            <span>
              {detail.check.camera} ·{" "}
              {new Date(detail.check.captured_ms).toLocaleTimeString()}
            </span>
          </div>
          <div
            className="perception-image"
            style={{
              aspectRatio: `${detail.check.width}/${detail.check.height}`,
            }}
          >
            <img
              src={
                detail.check.source_url ?? detail.check.preview_url ?? undefined
              }
              alt={
                detail.check.source_url
                  ? "Exact analyzed camera frame"
                  : "Legacy result preview"
              }
            />
            {visible &&
              detail.check.source_url &&
              detail.result &&
              (detail.result.kind === "segment" ? (
                <MaskLayer
                  detail={detail}
                  opacity={opacity}
                  outlines={outlines}
                />
              ) : (
                <img
                  className="perception-layer"
                  style={{ opacity }}
                  src={detail.check.preview_url ?? undefined}
                  alt="Relative depth overlay"
                />
              ))}
            <div className="perception-live-inset">
              <img
                src={`/api/cameras/${detail.check.camera}?t=${viewTick}`}
                alt="Current live camera preview"
              />
              <span>LIVE NOW</span>
            </div>
          </div>
          {detail.check.source_url ? (
            <div className="perception-layer-controls">
              <label>
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => setVisible(e.target.checked)}
                />{" "}
                Overlay
              </label>
              {detail.check.kind === "segment" ? (
                <label>
                  <input
                    type="checkbox"
                    checked={outlines}
                    onChange={(e) => setOutlines(e.target.checked)}
                  />{" "}
                  Outlines
                </label>
              ) : (
                <span className="depth-legend">
                  Relative depth <i aria-hidden="true" /> Low → high · no metric
                  distance
                </span>
              )}
              <label>
                Opacity{" "}
                <input
                  aria-label="Overlay opacity"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                />
              </label>
            </div>
          ) : (
            <p>
              Original camera image unavailable for this older check. Standalone
              preview only.
            </p>
          )}
          {detail.result?.kind === "segment" ? (
            <div className="perception-labels">
              {detail.result.masks?.length
                ? detail.result.masks.map((mask, index) => (
                    <span key={index}>
                      {mask.label}
                      {mask.score === undefined
                        ? ""
                        : ` · ${Math.round(mask.score * 100)}%`}
                    </span>
                  ))
                : "No objects found"}
            </div>
          ) : null}
          {detail.check.error ? (
            <p className="error" role="alert">
              {detail.check.error}
            </p>
          ) : null}
          <details>
            <summary>{detail.check.state} · Check details</summary>
            <p>{detail.check.model}</p>
            <p>Frame {detail.check.frame_id}</p>
            <p>
              {detail.check.completed_ms
                ? `${((detail.check.completed_ms - detail.check.created) / 1000).toFixed(1)}s processing`
                : "No completed result"}
            </p>
          </details>
        </>
      )}
    </section>
  );
}
export function PerceptionHistory({
  revision,
  onSelect,
  recordingId,
  recordingCreated,
}: {
  revision: number;
  onSelect: (id: string) => void;
  recordingId?: string;
  recordingCreated?: number | undefined;
}) {
  const [items, setItems] = useState<readonly PerceptionCheck[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setError("");
    void api(`perception${recordingId ? `?recording_id=${recordingId}` : ""}`)
      .then((raw) => {
        if (current !== generation.current) return;
        const page = Schema.decodeUnknownSync(PerceptionPage)(raw);
        setItems(page.items);
        setNext(page.next);
      })
      .catch((error) => {
        if (current === generation.current) setError(String(error));
      });
  }, [revision, recordingId]);
  return (
    <section
      className="perception-history"
      aria-label={
        recordingId ? "Recording perception markers" : "Perception history"
      }
    >
      <div className="perception-history-head">
        <span className="eyebrow">
          {recordingId ? "PERCEPTION MARKERS" : "RECENT CHECKS"}
        </span>
        <span>{items.length} checks</span>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="perception-filmstrip">
        {items.map((item) => (
          <button
            type="button"
            key={item.id}
            onClick={() => onSelect(item.id)}
            aria-label={`Review ${item.prompt} ${item.state}`}
          >
            {item.source_url || item.preview_url ? (
              <img
                src={item.source_url ?? item.preview_url ?? undefined}
                alt=""
                loading="lazy"
              />
            ) : (
              <div className="perception-placeholder">{item.state}</div>
            )}
            <strong>{item.prompt}</strong>
            <span>
              {item.camera} · {item.kind}
            </span>
            <small>
              {recordingCreated === undefined
                ? new Date(item.captured_ms).toLocaleTimeString()
                : `+${Math.max(0, (item.captured_ms - recordingCreated) / 1000).toFixed(1)}s`}{" "}
              · {item.state}
            </small>
          </button>
        ))}
        {items.length === 0 ? (
          <p>
            Perception checks appear here, including checks made by the agent.
          </p>
        ) : null}
      </div>
      {next ? (
        <button
          type="button"
          onClick={async () => {
            const current = generation.current;
            try {
              const page = Schema.decodeUnknownSync(PerceptionPage)(
                await api(
                  `perception?before=${next}${recordingId ? `&recording_id=${recordingId}` : ""}`
                )
              );
              if (current === generation.current) {
                setItems((previous) => [
                  ...previous,
                  ...page.items.filter(
                    (item) => !previous.some((old) => old.id === item.id)
                  ),
                ]);
                setNext(page.next);
              }
            } catch (error) {
              setError(String(error));
            }
          }}
        >
          Older checks
        </button>
      ) : null}
    </section>
  );
}
