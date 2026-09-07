import type { AppEvent } from "@robo/domain";
import { useEffect, useState } from "react";

export function useEvents(logged: boolean | null) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [draft, setDraft] = useState("");
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
  }, [logged]);
  return { events, setEvents, draft, setDraft };
}
