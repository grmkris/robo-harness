import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  joints,
  type AppEvent,
  type Observation,
  type ProviderInfo,
} from "../shared/contracts";

import "./style.css";

type Status = {
  access_mode: "tailnet" | "token";
  observation: Observation | null;
  robot_error: string | null;
  received_at: number;
  controller: string;
  running: string[];
  providers: ProviderInfo[];
  conversations: Array<{ id: string; provider: string; created: number }>;
  recording: {
    id: string;
    label: string;
    frames: number;
    state: string;
  } | null;
  telemetry: {
    online: boolean;
    error: string | null;
    dropped: number;
    version: string;
  };
  clock: { uncertainty_ms: number };
  perception: { configured: boolean; provider: string; cost_usd: number };
  budget: { limit_usd: number; spent_usd: number } | null;
};
type Recorded = {
  id: string;
  label: string;
  created: number;
  frames: number;
  state: string;
  error: string | null;
};
// HTTP tailnet origins lack randomUUID; getRandomValues also works there.
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
const browserController = sessionStorage.getItem("robo-controller") ?? newId();
sessionStorage.setItem("robo-controller", browserController);
async function api<T = Record<string, unknown>>(
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Robo-Browser": browserController,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "AUTH_REQUIRED"
        : (result.error ?? "Request failed")
    );
  return result;
}
const tool = (name: string, input: unknown = {}) => api("tool/" + name, input);
const label = (value: string) => value.replaceAll("_", " ");
const time = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
function MoveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        d="M12 2v20m3-3l-3 3l-3-3M19 9l3 3l-3 3M2 12h20M5 9l-3 3l3 3M9 5l3-3l3 3"
      />
    </svg>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-mark">
        RH<span>01</span>
      </div>
      <p className="eyebrow">A WORKBENCH FOR EMBODIED INTELLIGENCE</p>
      <h1>
        Meet your
        <br />
        <em>next pair of hands.</em>
      </h1>
      <p className="intro">One arm. Two cameras. An open-ended conversation.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("login", { token });
            onDone();
          } catch (e) {
            setError(
              (e as Error).message === "AUTH_REQUIRED"
                ? "Incorrect operator token"
                : (e as Error).message
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="token">Operator token</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          placeholder="Enter your local operator token"
        />
        <button className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Open workbench"} <span>↗</span>
        </button>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </form>
      <small>Private lab access · SO-101</small>
    </main>
  );
}
function App() {
  const [logged, setLogged] = useState<boolean | null>(null),
    [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState("");
  const [events, setEvents] = useState<AppEvent[]>([]),
    [tab, setTab] = useState("chat"),
    [replay, setReplay] = useState<string | null>(null);
  const [records, setRecords] = useState<Recorded[]>([]),
    [fallback, setFallback] = useState(false),
    [pending, setPending] = useState(false);
  const [recordName, setRecordName] = useState(
    "Exploration " + new Date().toLocaleDateString()
  );
  const [session, setSession] = useState<string | undefined>(
      () => sessionStorage.getItem("robo-conversation") ?? undefined
    ),
    [provider, setProvider] = useState(""),
    [message, setMessage] = useState("");
  const [draft, setDraft] = useState(""),
    [camera, setCamera] = useState("workspace"),
    [perceptionPrompt, setPerceptionPrompt] = useState("white object");
  const [command, setCommand] = useState("python --version"),
    [shellHost, setShellHost] = useState("netcup"),
    [shellResult, setShellResult] = useState("");
  const [budgetInput, setBudgetInput] = useState("1"),
    [jogStep, setJogStep] = useState(2),
    [cartStep, setCartStep] = useState(0.005);
  const [viewTick, setViewTick] = useState(0),
    [viewerKey, setViewerKey] = useState(0),
    [perceptionBusy, setPerceptionBusy] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Status>("status");
      setStatus(next);
      setLogged(true);
    } catch (e) {
      if ((e as Error).message === "AUTH_REQUIRED") setLogged(false);
      else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    if (logged === false) return;
    void refresh();
    const id = setInterval(() => {
      void refresh();
      setViewTick((v) => v + 1);
    }, 700);
    return () => clearInterval(id);
  }, [refresh, logged]);
  useEffect(() => {
    if (!logged) return;
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as AppEvent;
      setEvents((previous) =>
        previous.some((p) => p.id === event.id)
          ? previous
          : [...previous, event].slice(-250)
      );
      if (event.type === "chat.delta")
        setDraft((v) => v + String(event.data["text"]));
      if (event.type === "chat.message" && event.data["role"] === "assistant")
        setDraft("");
      if (event.type === "chat.finished") setDraft("");
    };
    return () => source.close();
  }, [logged]);
  useEffect(() => {
    if (!provider && status?.providers.some((p) => p.available))
      setProvider(status.providers.find((p) => p.available)!.id);
  }, [status?.providers, provider]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, draft]);
  useEffect(() => {
    if (tab !== "recordings" || !logged) return;
    void api<Recorded[]>("recordings")
      .then(setRecords)
      .catch((e) => setError(e.message));
  }, [tab, logged, status?.recording]);
  useEffect(() => {
    if (session) sessionStorage.setItem("robo-conversation", session);
    else sessionStorage.removeItem("robo-conversation");
    if (!logged || !session) return;
    void api<{ conversation: { provider: string }; events: AppEvent[] }>(
      "conversations/" + session
    )
      .then((result) => {
        setProvider(result.conversation.provider);
        setEvents((previous) =>
          [
            ...new Map(
              [...previous, ...result.events].map((e) => [e.id, e])
            ).values(),
          ].sort((a, b) => a.id - b.id)
        );
      })
      .catch((e) => setError(e.message));
  }, [session, logged]);
  const obs = status?.observation;
  const own = Boolean(logged && obs?.operator?.owner === status?.controller);
  const fresh = Boolean(
    obs &&
    !status?.robot_error &&
    Date.now() - (status?.received_at ?? 0) < 1500 &&
    !obs.fault
  );
  const activeMove =
    obs?.operation?.status === "running" ||
    obs?.operation?.status === "accepted";
  useEffect(() => {
    if (!own) return;
    const id = setInterval(() => {
      void tool("renew").catch((e) => setError(e.message));
    }, 900);
    return () => clearInterval(id);
  }, [own]);
  const run = async (name: string, input: unknown = {}) => {
    setPending(true);
    setError("");
    try {
      const result = await tool(name, input);
      await refresh();
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setPending(false);
    }
  };
  const halt = async () => {
    setError("");
    try {
      await tool("stop");
      await refresh();
    } catch (e) {
      setError("Stop command was not acknowledged: " + (e as Error).message);
    }
  };
  if (logged === false)
    return (
      <Login
        onDone={() => {
          void refresh();
        }}
      />
    );
  if (!status)
    return <div className="connecting">Connecting to the workbench…</div>;
  const running = session ? status.running.includes(session) : false;
  const available = status.providers.some((p) => p.available);
  const viewerUrl =
    "/rerun/viewer/?theme=dark&url=" +
    encodeURIComponent(
      replay
        ? location.origin + "/api/recordings/" + replay + "/replay.rrd"
        : "rerun+" + location.origin + "/proxy"
    );
  const chatEvents = events.filter(
    (e) =>
      e.type.startsWith("chat.") &&
      e.data["session_id"] === session &&
      !["chat.delta", "chat.finished"].includes(e.type)
  );
  const lastPerception = events.findLast(
    (e) => e.type === "perception.completed"
  );
  const moveJoint = async (j: (typeof joints)[number], delta: number) => {
    if (!obs) return;
    await run("move", {
      request_id: newId(),
      target: { [j]: obs.measured[j] + delta },
      duration_s: 1,
    });
  };
  const moveCartesian = async (axis: number, delta: number) => {
    if (!obs) return;
    const xyz = [...obs.ee];
    xyz[axis] = (xyz[axis] ?? 0) + delta;
    await run("move", { request_id: newId(), xyz, duration_s: 1 });
  };
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          RH
          <span className="brand-separator" />
          ROBO HARNESS<sup>LAB / 01</sup>
        </a>
        <div className="top-status">
          <span className={"led " + (fresh ? "good" : "bad")} />
          {fresh ? "ROBOT CONNECTED" : "ROBOT UNAVAILABLE"}
          <span className="backend">
            {obs?.backend === "mock" ? "SIMULATED" : "SO-101"}
          </span>
        </div>
        {status.access_mode === "token" ? (
          <button
            className="quiet"
            onClick={() => {
              void api("logout", {}).then(() => setLogged(false));
            }}
          >
            Lock workbench ↗
          </button>
        ) : (
          <span className="eyebrow">TAILSCALE ACCESS</span>
        )}
      </header>
      <div className="title-row">
        <div>
          <p className="eyebrow">OBSERVE. REASON. MOVE.</p>
          <h1>
            The robot workbench<span className="title-dot">.</span>
          </h1>
        </div>
        <div className="session-note">
          <span>SO-101 · 6 AXES</span>
          <span>Workspace + wrist vision</span>
        </div>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            ×
          </button>
        </div>
      ) : null}
      <div className="workbench">
        <section className="visual panel">
          <div className="panel-head">
            <div className="panel-heading">
              <span className="eyebrow">01 / OBSERVATION</span>
              <strong>{replay ? "Recorded session" : "Live workspace"}</strong>
            </div>
            <div className="toolbar">
              {replay ? (
                <button
                  onClick={() => {
                    setReplay(null);
                    setViewerKey((v) => v + 1);
                  }}
                >
                  Return to live
                </button>
              ) : null}
              <button
                aria-pressed={fallback}
                onClick={() => setFallback((v) => !v)}
              >
                {fallback ? "Rerun view" : "Camera view"}
              </button>
              <button
                aria-label="Reload visualization"
                onClick={() => setViewerKey((v) => v + 1)}
              >
                ↻
              </button>
            </div>
          </div>
          <div className="viewer-shell">
            {fallback || !status.telemetry.online || status.telemetry.error ? (
              <div className="camera-fallback">
                <div className="camera-grid">
                  {["workspace", "wrist"].map((name) => (
                    <figure key={name}>
                      <img
                        src={"/api/cameras/" + name + "?t=" + viewTick}
                        alt={name + " camera"}
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
                {!fallback ? (
                  <div className="viewer-notice">
                    <strong>Rerun is reconnecting</strong>
                    <span>
                      {status.telemetry.error ??
                        "Waiting for the telemetry worker. Live cameras remain available."}
                    </span>
                  </div>
                ) : null}
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
            <div className={"view-label " + (replay ? "history" : "")}>
              <span className="led" />
              {replay
                ? "HISTORICAL RECORDING"
                : "LIVE FEED · VIEWER TIMELINE CAN BE PAUSED"}
              <span>Controls always use current state</span>
            </div>
          </div>
          <div className="visual-footer">
            <span>RERUN {status.telemetry.version || "0.30.1"}</span>
            <span>
              Clock uncertainty ±{Math.round(status.clock.uncertainty_ms)} ms
            </span>
            <span>{status.telemetry.dropped} skipped preview samples</span>
          </div>
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
              href={"/api/perception/" + lastPerception.data["id"]}
              target="_blank"
              rel="noreferrer"
            >
              Open latest perception result ↗
            </a>
          ) : null}
        </section>
        <aside className="side panel">
          <nav className="tabs" aria-label="Workbench tools">
            {["chat", "terminal", "recordings", "activity"].map((name) => (
              <button
                key={name}
                className={tab === name ? "selected" : ""}
                onClick={() => setTab(name)}
              >
                {label(name)}
              </button>
            ))}
          </nav>
          {tab === "chat" ? (
            <>
              <div className="chat-settings">
                <select
                  aria-label="Agent provider"
                  value={provider}
                  disabled={running}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    setSession(undefined);
                    setDraft("");
                  }}
                >
                  <option value="">Choose provider</option>
                  {status.providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.available}>
                      {p.name}
                      {p.available ? "" : " · unavailable"}
                    </option>
                  ))}
                </select>
                <button
                  className="quiet"
                  disabled={running}
                  onClick={() => {
                    setSession(undefined);
                    setDraft("");
                  }}
                >
                  New
                </button>
              </div>
              <div className="conversation-row">
                <select
                  aria-label="Conversation"
                  value={session ?? ""}
                  disabled={running}
                  onChange={(e) => {
                    setSession(e.target.value || undefined);
                    setDraft("");
                  }}
                >
                  <option value="">New conversation</option>
                  {status.conversations?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.provider} · {new Date(c.created).toLocaleString()}
                    </option>
                  ))}
                </select>
              </div>
              <div className="chat-log" aria-live="polite">
                {chatEvents.length === 0 ? (
                  <div className="chat-empty">
                    <div className="orb">
                      <MoveIcon />
                    </div>
                    <p className="eyebrow">YOUR LAB PARTNER</p>
                    <h2>
                      What can we
                      <br />
                      make it do?
                    </h2>
                    <p>
                      Ask the agent to look around, inspect a joint, or try a
                      small movement.
                    </p>
                    <button
                      className="suggestion"
                      onClick={() =>
                        setMessage(
                          "Inspect the robot state and describe what you can observe. Do not move yet."
                        )
                      }
                    >
                      Inspect the workspace <span>↗</span>
                    </button>
                  </div>
                ) : null}
                {chatEvents.map((e) => (
                  <article
                    className={
                      "chat-event " + (e.data["role"] === "user" ? "user" : "")
                    }
                    key={e.id}
                  >
                    <small>
                      {e.type === "chat.message"
                        ? e.data["role"] === "user"
                          ? "YOU"
                          : "AGENT"
                        : e.type
                            .replace("chat.", "")
                            .replaceAll("_", " ")
                            .toUpperCase()}{" "}
                      <time>{time(e.time)}</time>
                    </small>
                    {e.type === "chat.message" ? (
                      <p>{String(e.data["text"])}</p>
                    ) : e.type === "chat.tool" ? (
                      <details>
                        <summary>{String(e.data["name"])}</summary>
                        <pre>{JSON.stringify(e.data["input"], null, 2)}</pre>
                      </details>
                    ) : e.type === "chat.tool_result" ? (
                      <details>
                        <summary>{String(e.data["name"])} · result</summary>
                        <pre>{JSON.stringify(e.data["output"], null, 2)}</pre>
                      </details>
                    ) : (
                      <p>{String(e.data["message"] ?? e.data["text"] ?? "")}</p>
                    )}
                  </article>
                ))}
                {draft ? (
                  <article className="chat-event">
                    <small>
                      AGENT <span className="typing">●</span>
                    </small>
                    <p>{draft}</p>
                  </article>
                ) : null}
                <div ref={chatEnd} />
              </div>
              {!available ? (
                <div className="provider-note">
                  Connect Alibaba Token Plan or xAI in the app environment to
                  enable chat. Manual controls work independently.
                </div>
              ) : null}
              <form
                className="composer"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!message.trim()) return;
                  setError("");
                  try {
                    if (running) {
                      await api("chat/steer", { id: session, text: message });
                    } else {
                      const reply = await api<{ session_id: string }>("chat", {
                        provider,
                        text: message,
                        session_id: session,
                      });
                      setSession(reply.session_id);
                    }
                    setMessage("");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <textarea
                  aria-label="Message the robot agent"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={
                    running
                      ? "Steer the current turn…"
                      : "Ask, observe, experiment…"
                  }
                  rows={3}
                />
                <div>
                  <span>
                    {running ? "Agent is working" : "Custom agent loop"}
                  </span>
                  {running ? (
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        void api("chat/cancel", { id: session });
                      }}
                    >
                      Cancel turn
                    </button>
                  ) : null}
                  <button
                    className="send"
                    disabled={!provider || !message.trim()}
                  >
                    {running ? "Steer" : "Send"} ↗
                  </button>
                </div>
              </form>
            </>
          ) : null}
          {tab === "terminal" ? (
            <div className="tab-body">
              <p className="eyebrow">DEVELOPMENT WORKSPACE</p>
              <h2>Try a program.</h2>
              <p className="muted">
                Commands run in a development environment. Activating hardware
                changes stays a reviewed step.
              </p>
              <select
                aria-label="Shell host"
                value={shellHost}
                onChange={(e) => setShellHost(e.target.value)}
              >
                <option value="netcup">Netcup container</option>
                <option value="pi">Pi development account</option>
              </select>
              <textarea
                className="code-input"
                aria-label="Shell command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                rows={7}
              />
              <button
                className="primary"
                disabled={pending || !command.trim()}
                onClick={async () => {
                  const out = await run("shell", {
                    command,
                    host: shellHost,
                    timeout_s: 30,
                  });
                  if (out) setShellResult(JSON.stringify(out, null, 2));
                }}
              >
                Run command ↗
              </button>
              <pre className="terminal-output">
                {shellResult || "$ Ready when you are."}
              </pre>
            </div>
          ) : null}
          {tab === "recordings" ? (
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
                className={status.recording ? "danger-outline" : "primary"}
                disabled={pending || (!status.recording && !fresh)}
                onClick={() => {
                  void run(
                    status.recording ? "recording_stop" : "recording_start",
                    status.recording ? {} : { label: recordName }
                  );
                }}
              >
                {status.recording
                  ? "Stop recording · " + status.recording.frames + " frames"
                  : "Start recording"}
              </button>
              <div className="record-list">
                {records.map((r) => (
                  <article key={r.id}>
                    <div>
                      <strong>{r.label}</strong>
                      <small>
                        {new Date(r.created).toLocaleString()} · {r.frames}{" "}
                        frames
                      </small>
                      <span className="pill">{r.state}</span>
                      {r.error ? <p className="error">{r.error}</p> : null}
                    </div>
                    <button
                      onClick={() => {
                        setReplay(r.id);
                        setFallback(false);
                        setViewerKey((v) => v + 1);
                      }}
                    >
                      Replay ↗
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          {tab === "activity" ? (
            <div className="tab-body">
              <p className="eyebrow">SYSTEM JOURNAL</p>
              <h2>Every action, visible.</h2>
              <div className="budget-box">
                <label htmlFor="budget">Perception spending cap (USD)</label>
                <div>
                  <input
                    id="budget"
                    type="number"
                    min="0"
                    max="1000"
                    step=".1"
                    value={budgetInput}
                    onChange={(e) => setBudgetInput(e.target.value)}
                  />
                  <button
                    onClick={() => {
                      void api("budget", { limit: Number(budgetInput) })
                        .then(refresh)
                        .catch((e) => setError(e.message));
                    }}
                  >
                    Set cap
                  </button>
                </div>
                <small>
                  {status.budget
                    ? "$" +
                      status.budget.spent_usd.toFixed(2) +
                      " reserved / $" +
                      status.budget.limit_usd.toFixed(2)
                    : "No paid compute approved"}{" "}
                  ·{" "}
                  {status.perception.configured
                    ? status.perception.provider + " configured"
                    : "No inference endpoint"}
                </small>
              </div>
              <ol className="event-list">
                {events
                  .filter((e) => !e.type.startsWith("chat."))
                  .slice(-50)
                  .reverse()
                  .map((e) => (
                    <li key={e.id}>
                      <time>{time(e.time)}</time>
                      <strong>{e.type}</strong>
                      <details>
                        <summary>Details</summary>
                        <pre>{JSON.stringify(e.data, null, 2)}</pre>
                      </details>
                    </li>
                  ))}
              </ol>
            </div>
          ) : null}
        </aside>
      </div>
      <section className="control-deck panel">
        <div className="control-header">
          <div className="panel-heading">
            <span className="eyebrow">02 / CONTROL</span>
            <strong>
              <MoveIcon />{" "}
              {obs?.operator
                ? label(obs.operator.mode) + " control"
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
                      ? Math.max(
                          0,
                          Math.min(
                            100,
                            ((obs.measured[j] - obs.limits[j][0]) /
                              (obs.limits[j][1] - obs.limits[j][0])) *
                              100
                          )
                        ) + "%"
                      : "50%",
                  }}
                />
              </div>
              <div className="joint-jog">
                <button
                  aria-label={"Decrease " + label(j)}
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
                  aria-label={"Increase " + label(j)}
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
                aria-label={"Decrease Cartesian " + axis}
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
                aria-label={"Increase Cartesian " + axis}
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
      <footer className="footer">
        <span>SMALL ARM. OPEN POSSIBILITIES.</span>
        <span>
          {obs?.operation
            ? "Last motion: " + obs.operation.status
            : "Ready to explore"}{" "}
          · {obs?.calibration_id ?? "No calibration"}
        </span>
        <span>NETCUP ↔ LAB-PI</span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
