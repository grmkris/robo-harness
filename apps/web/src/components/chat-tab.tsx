import type { AppEvent, ProviderInfo } from "@robo/domain";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { api, time } from "../lib/client";
import type { Status } from "../lib/types";
import { MoveIcon } from "./icons";

export function ChatTab({
  providers,
  conversations,
  provider,
  setProvider,
  session,
  setSession,
  running,
  draft,
  setDraft,
  chatEvents,
  message,
  setMessage,
  available,
  setError,
  chatEndRef,
}: {
  providers: ProviderInfo[];
  conversations: Status["conversations"];
  provider: string;
  setProvider: Dispatch<SetStateAction<string>>;
  session: string | undefined;
  setSession: Dispatch<SetStateAction<string | undefined>>;
  running: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  chatEvents: AppEvent[];
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  available: boolean;
  setError: Dispatch<SetStateAction<string>>;
  chatEndRef: RefObject<HTMLDivElement | null>;
}) {
  return (
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
          {providers.map((p) => (
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
          {conversations?.map((c) => (
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
              Ask the agent to look around, inspect a joint, or try a small
              movement.
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
            className={`chat-event ${e.data["role"] === "user" ? "user" : ""}`}
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
        <div ref={chatEndRef} />
      </div>
      {available ? null : (
        <div className="provider-note">
          Connect Alibaba Token Plan or xAI in the app environment to enable
          chat. Manual controls work independently.
        </div>
      )}
      <form
        className="composer"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!message.trim()) {
            return;
          }
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
          } catch (error) {
            setError((error as Error).message);
          }
        }}
      >
        <textarea
          aria-label="Message the robot agent"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            running ? "Steer the current turn…" : "Ask, observe, experiment…"
          }
          rows={3}
        />
        <div>
          <span>{running ? "Agent is working" : "Custom agent loop"}</span>
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
          <button className="send" disabled={!provider || !message.trim()}>
            {running ? "Steer" : "Send"} ↗
          </button>
        </div>
      </form>
    </>
  );
}
