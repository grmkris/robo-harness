import type { AppEvent } from "@robo/domain";
import { useEffect, useState } from "react";

export function useEvents(logged: boolean | null, session: string | undefined) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [draft, setDraft] = useState("");
  // The streaming draft belongs to the conversation being viewed, so switching
  // conversations must not carry a half-streamed reply across.
  useEffect(() => {
    setDraft("");
  }, [session]);
  useEffect(() => {
    if (!logged) {
      return;
    }
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      const event = JSON.parse(e.data) as AppEvent;
      setEvents((previous) =>
        previous.some((p) => p.id === event.id)
          ? previous
          : [...previous, event].slice(-250)
      );
      // Only the open session's deltas feed its draft; another session's stream
      // must not bleed into this view.
      if (event.data["session_id"] !== session) {
        return;
      }
      if (event.type === "chat.delta") {
        setDraft((v) => v + String(event.data["text"]));
      }
      if (event.type === "chat.message" && event.data["role"] === "assistant") {
        setDraft("");
      }
      if (event.type === "chat.finished") {
        setDraft("");
      }
    };
    return () => source.close();
  }, [logged, session]);
  return { events, setEvents, draft, setDraft };
}
