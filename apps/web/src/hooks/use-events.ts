import { AppEvent } from "@robo/domain";
import { Schema } from "effect";
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
    let lastEventId = 0;
    const source = new EventSource("/api/events");
    source.onmessage = (e) => {
      const decoded = Schema.decodeUnknownOption(
        Schema.fromJsonString(AppEvent)
      )(e.data);
      if (decoded._tag === "None" || decoded.value.id <= lastEventId) return;
      const event = decoded.value;
      lastEventId = event.id;
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
