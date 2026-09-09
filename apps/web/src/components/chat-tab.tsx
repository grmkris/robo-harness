import type { AppEvent } from "@robo/domain";
import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

import { api, time } from "../lib/client";
import type { Status } from "../lib/types";
import { ChatMotionEntry, ChatToolEntry } from "./chat-entry";

export interface ModelOption {
  model: string;
  provider: string;
  providerName: string;
  vision: boolean;
}

export function ChatTab({
  modelOptions,
  conversations,
  provider,
  setProvider,
  model,
  setModel,
  session,
  setSession,
  running,
  draft,
  setDraft,
  chatEvents,
  pendingUser,
  setPendingUser,
  message,
  setMessage,
  available,
  setError,
  chatEndRef,
}: {
  modelOptions: ModelOption[];
  conversations: Status["conversations"];
  provider: string;
  setProvider: Dispatch<SetStateAction<string>>;
  model: string;
  setModel: Dispatch<SetStateAction<string>>;
  session: string | undefined;
  setSession: Dispatch<SetStateAction<string | undefined>>;
  running: boolean;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  chatEvents: AppEvent[];
  pendingUser: string | null;
  setPendingUser: Dispatch<SetStateAction<string | null>>;
  message: string;
  setMessage: Dispatch<SetStateAction<string>>;
  available: boolean;
  setError: Dispatch<SetStateAction<string>>;
  chatEndRef: RefObject<HTMLDivElement | null>;
}) {
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
  }, [session]);
  useEffect(() => {
    if (follow.current)
      chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [chatEvents.length, draft, chatEndRef]);
  const selectedModel = modelOptions.find(
    (option) => option.provider === provider && option.model === model
  );
  const latestMotion = new Map<string, number>();
  for (const event of chatEvents) {
    if (event.type === "chat.motion")
      latestMotion.set(String(event.data["action_id"]), event.id);
  }
  const results = new Map<string, AppEvent>();
  const calls = new Set<string>();
  for (const event of chatEvents) {
    const id = String(event.data["tool_call_id"] ?? "");
    if (!id) continue;
    if (event.type === "chat.tool") calls.add(id);
    if (["chat.tool_result", "chat.tool_error"].includes(event.type))
      results.set(id, event);
  }
  const visibleEvents = chatEvents.filter((event) => {
    if (event.type === "chat.status") return false;
    if (event.type === "chat.motion")
      return latestMotion.get(String(event.data["action_id"])) === event.id;
    if (["chat.tool_result", "chat.tool_error"].includes(event.type))
      return !calls.has(String(event.data["tool_call_id"] ?? ""));
    return true;
  });
  const latest = chatEvents.at(-1);
  const runStatus =
    latest?.type === "chat.status"
      ? String(latest.data["message"])
      : "Working…";
  const resetConversation = () => {
    setSession(undefined);
    setDraft("");
    setPendingUser(null);
  };
  return (
    <>
      <div className="chat-settings">
        <select
          aria-label="Model"
          value={provider && model ? `${provider}:${model}` : ""}
          disabled={running}
          onChange={(e) => {
            const [prov, ...rest] = e.target.value.split(":");
            setProvider(prov ?? "");
            setModel(rest.join(":"));
            resetConversation();
          }}
        >
          <option value="">Choose model</option>
          {modelOptions.map((o) => (
            <option
              key={`${o.provider}:${o.model}`}
              value={`${o.provider}:${o.model}`}
            >
              {o.model}
            </option>
          ))}
        </select>
        {selectedModel ? (
          <span
            className="model-capability"
            aria-label="Model image capability"
            title={
              selectedModel.vision
                ? "Camera images enabled"
                : "Camera images unavailable"
            }
          >
            {selectedModel.vision ? "Images" : "Text only"}
          </span>
        ) : null}
        <button
          type="button"
          className="quiet"
          disabled={running}
          onClick={resetConversation}
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
            setPendingUser(null);
          }}
        >
          <option value="">New conversation</option>
          {conversations?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.model ?? c.provider} · {new Date(c.created).toLocaleString()}
            </option>
          ))}
        </select>
      </div>
      <div
        className="chat-log"
        aria-live="polite"
        onScroll={(event) => {
          const log = event.currentTarget;
          follow.current =
            log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        }}
      >
        {chatEvents.length === 0 && !pendingUser ? (
          <div className="chat-empty">
            <p>
              Send an instruction, or inspect the current state and cameras.
            </p>
            <button
              type="button"
              className="suggestion"
              onClick={() =>
                setMessage(
                  "Observe the robot and capture both workspace and wrist cameras. Briefly describe what you see. Do not move."
                )
              }
            >
              Observe + capture
            </button>
          </div>
        ) : null}
        {visibleEvents.map((e) =>
          ["chat.tool", "chat.tool_result", "chat.tool_error"].includes(
            e.type
          ) ? (
            <ChatToolEntry
              key={e.id}
              running={running}
              event={e}
              result={results.get(String(e.data["tool_call_id"] ?? ""))}
            />
          ) : e.type === "chat.motion" ? (
            <ChatMotionEntry key={e.id} event={e} />
          ) : (
            <article
              className={`chat-event ${e.data["role"] === "user" ? "user" : ""} ${e.type === "chat.error" ? "chat-failure" : ""}`}
              key={e.id}
            >
              <small>
                {e.type === "chat.message"
                  ? e.data["role"] === "user"
                    ? "You"
                    : model
                  : e.type
                      .replace("chat.", "")
                      .replaceAll("_", " ")
                      .toUpperCase()}{" "}
                <time>{time(e.time)}</time>
              </small>
              {e.type === "chat.message" ? (
                <p>{String(e.data["text"])}</p>
              ) : (
                <p>{String(e.data["message"] ?? e.data["text"] ?? "")}</p>
              )}
            </article>
          )
        )}
        {pendingUser ? (
          <article className="chat-event user">
            <small>
              You <span className="typing">●</span>
            </small>
            <p>{pendingUser}</p>
          </article>
        ) : null}
        {draft ? (
          <article className="chat-event">
            <small>
              {model} <span className="typing">●</span>
            </small>
            <p>{draft}</p>
          </article>
        ) : null}
        {running && !draft ? (
          <output className="chat-working">{runStatus}</output>
        ) : null}
        <div ref={chatEndRef} />
      </div>
      {available ? null : (
        <div className="provider-note">No model connected.</div>
      )}
      <form
        className="composer"
        onSubmit={async (e) => {
          e.preventDefault();
          const text = message.trim();
          if (!text) {
            return;
          }
          setError("");
          try {
            if (running) {
              await api("chat/steer", { id: session, text });
            } else {
              setPendingUser(text);
              const reply = await api<{ session_id: string }>("chat", {
                provider,
                model,
                text,
                session_id: session,
              });
              setSession(reply.session_id);
            }
            setMessage("");
          } catch (error) {
            setPendingUser(null);
            setError((error as Error).message);
          }
        }}
      >
        <textarea
          aria-label="Message the robot agent"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={
            running ? "Update the current instruction…" : "Message the robot…"
          }
          rows={3}
        />
        <div>
          <span>{running ? "New messages steer this turn" : ""}</span>
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
          <button className="send" disabled={!model || !message.trim()}>
            {running ? "Steer" : "Send"}
          </button>
        </div>
      </form>
    </>
  );
}
