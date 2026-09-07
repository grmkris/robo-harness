import type { joints } from "@robo/domain";
import { useEffect, useRef, useState } from "react";

import { ActivityTab } from "./components/activity-tab";
import { ChatTab } from "./components/chat-tab";
import { ControlDeck } from "./components/control-deck";
import { Login } from "./components/login";
import { PerceptionBar } from "./components/perception-bar";
import { RecordingsTab } from "./components/recordings-tab";
import { TerminalTab } from "./components/terminal-tab";
import { TitleRow } from "./components/title-row";
import { TopBar } from "./components/top-bar";
import { Viewer } from "./components/viewer";
import { useConversation } from "./hooks/use-conversation";
import { useEvents } from "./hooks/use-events";
import { useLease } from "./hooks/use-lease";
import { useRecordings } from "./hooks/use-recordings";
import { useRun } from "./hooks/use-run";
import { useStatus } from "./hooks/use-status";
import { label, newId } from "./lib/client";

export function App() {
  const { logged, setLogged, status, error, setError, viewTick, refresh } =
    useStatus();
  const [session, setSession] = useState<string | undefined>(
    () => sessionStorage.getItem("robo-conversation") ?? undefined
  );
  const { events, setEvents, draft, setDraft } = useEvents(logged, session);
  const [tab, setTab] = useState("chat");
  const [replay, setReplay] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const [recordName, setRecordName] = useState(
    `Exploration ${new Date().toLocaleDateString()}`
  );
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [camera, setCamera] = useState("workspace");
  const [perceptionPrompt, setPerceptionPrompt] = useState("white object");
  const [command, setCommand] = useState("python --version");
  const [shellHost, setShellHost] = useState("netcup");
  const [shellResult, setShellResult] = useState("");
  const [budgetInput, setBudgetInput] = useState("1");
  const [jogStep, setJogStep] = useState(2);
  const [cartStep, setCartStep] = useState(0.005);
  const [viewerKey, setViewerKey] = useState(0);
  const [perceptionBusy, setPerceptionBusy] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
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
  useConversation({
    logged,
    session,
    setProvider,
    setModel,
    setEvents,
    setError,
  });
  useLease(own, setError);
  const { records } = useRecordings({
    tab,
    logged,
    recording: status?.recording ?? null,
    setError,
  });
  const { pending, run, halt } = useRun({ refresh, setError });
  // Pick a sensible default model (the first available provider's first model)
  // once, so the flat picker starts on something usable.
  useEffect(() => {
    if (model) {
      return;
    }
    const first = status?.providers.find((p) => p.available && p.models.length);
    if (first) {
      setProvider(first.id);
      setModel(first.models[0]!);
    }
  }, [status?.providers, model]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, draft]);
  // Once the server echoes the optimistic message back for this session, drop
  // the local copy so it doesn't linger if the conversation is revisited.
  useEffect(() => {
    if (
      pendingUser !== null &&
      events.some(
        (e) =>
          e.type === "chat.message" &&
          e.data["session_id"] === session &&
          e.data["role"] === "user" &&
          e.data["text"] === pendingUser
      )
    ) {
      setPendingUser(null);
    }
  }, [events, session, pendingUser]);
  if (logged === false) {
    return (
      <Login
        onDone={() => {
          void refresh();
        }}
      />
    );
  }
  if (!status) {
    return <div className="connecting">Connecting to the workbench…</div>;
  }
  const running = session ? status.running.includes(session) : false;
  const available = status.providers.some((p) => p.available);
  const viewerUrl = `/rerun/viewer/?theme=dark&url=${encodeURIComponent(
    replay
      ? location.origin + "/api/recordings/" + replay + "/replay.rrd"
      : "rerun+" + location.origin + "/proxy"
  )}`;
  const chatEvents = events.filter(
    (e) =>
      e.type.startsWith("chat.") &&
      e.data["session_id"] === session &&
      !["chat.delta", "chat.finished"].includes(e.type)
  );
  // Every model of every available provider, flattened so chat picks a model
  // directly and the provider is inferred from the chosen entry.
  const modelOptions = (status?.providers ?? [])
    .filter((p) => p.available)
    .flatMap((p) =>
      p.models.map((m) => ({
        model: m,
        provider: p.id,
        providerName: p.name,
      }))
    );
  // The optimistic "YOU" bubble is shown until the server echoes the same text
  // back as a real user message for this session — then the real one takes over.
  const pendingEchoed =
    pendingUser !== null &&
    chatEvents.some(
      (e) =>
        e.type === "chat.message" &&
        e.data["role"] === "user" &&
        e.data["text"] === pendingUser
    );
  const pendingShown = pendingEchoed ? null : pendingUser;
  const lastPerception = events.findLast(
    (e) => e.type === "perception.completed"
  );
  const moveJoint = async (j: (typeof joints)[number], delta: number) => {
    if (!obs) {
      return;
    }
    await run("move", {
      request_id: newId(),
      target: { [j]: obs.measured[j] + delta },
      duration_s: 1,
    });
  };
  const moveCartesian = async (axis: number, delta: number) => {
    if (!obs) {
      return;
    }
    const xyz = [...obs.ee];
    xyz[axis] = (xyz[axis] ?? 0) + delta;
    await run("move", { request_id: newId(), xyz, duration_s: 1 });
  };
  return (
    <div className="app">
      <TopBar
        fresh={fresh}
        obs={obs}
        accessMode={status.access_mode}
        onLogout={() => setLogged(false)}
      />
      <TitleRow />
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
          <Viewer
            replay={replay}
            fallback={fallback}
            viewerKey={viewerKey}
            viewerUrl={viewerUrl}
            viewTick={viewTick}
            obs={obs}
            telemetry={status.telemetry}
            clockUncertaintyMs={status.clock.uncertainty_ms}
            onReturnLive={() => {
              setReplay(null);
              setViewerKey((v) => v + 1);
            }}
            onToggleFallback={() => setFallback((v) => !v)}
            onReload={() => setViewerKey((v) => v + 1)}
          />
          <PerceptionBar
            camera={camera}
            setCamera={setCamera}
            perceptionPrompt={perceptionPrompt}
            setPerceptionPrompt={setPerceptionPrompt}
            perceptionBusy={perceptionBusy}
            setPerceptionBusy={setPerceptionBusy}
            fresh={fresh}
            run={run}
            lastPerception={lastPerception}
          />
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
            <ChatTab
              modelOptions={modelOptions}
              conversations={status.conversations}
              provider={provider}
              setProvider={setProvider}
              model={model}
              setModel={setModel}
              session={session}
              setSession={setSession}
              running={running}
              draft={draft}
              setDraft={setDraft}
              chatEvents={chatEvents}
              pendingUser={pendingShown}
              setPendingUser={setPendingUser}
              message={message}
              setMessage={setMessage}
              available={available}
              setError={setError}
              chatEndRef={chatEnd}
            />
          ) : null}
          {tab === "terminal" ? (
            <TerminalTab
              command={command}
              setCommand={setCommand}
              shellHost={shellHost}
              setShellHost={setShellHost}
              pending={pending}
              run={run}
              shellResult={shellResult}
              setShellResult={setShellResult}
            />
          ) : null}
          {tab === "recordings" ? (
            <RecordingsTab
              recordName={recordName}
              setRecordName={setRecordName}
              recording={status.recording}
              pending={pending}
              fresh={fresh}
              run={run}
              records={records}
              onReplay={(id) => {
                setReplay(id);
                setFallback(false);
                setViewerKey((v) => v + 1);
              }}
            />
          ) : null}
          {tab === "activity" ? (
            <ActivityTab
              budgetInput={budgetInput}
              setBudgetInput={setBudgetInput}
              budget={status.budget}
              perception={status.perception}
              events={events}
              setError={setError}
              refresh={refresh}
            />
          ) : null}
        </aside>
      </div>
      <ControlDeck
        obs={obs}
        fresh={fresh}
        own={own}
        pending={pending}
        activeMove={activeMove}
        run={run}
        halt={halt}
        jogStep={jogStep}
        setJogStep={setJogStep}
        cartStep={cartStep}
        setCartStep={setCartStep}
        moveJoint={moveJoint}
        moveCartesian={moveCartesian}
      />
      <footer className="footer">
        <span>SMALL ARM. OPEN POSSIBILITIES.</span>
        <span>
          {obs?.operation
            ? `Last motion: ${obs.operation.status}`
            : "Ready to explore"}{" "}
          · {obs?.calibration_id ?? "No calibration"}
        </span>
        <span>NETCUP ↔ LAB-PI</span>
      </footer>
    </div>
  );
}
