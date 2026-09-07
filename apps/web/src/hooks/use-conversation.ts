import type { AppEvent } from "@robo/domain";
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../lib/client";

export function useConversation(opts: {
  logged: boolean | null;
  session: string | undefined;
  setProvider: Dispatch<SetStateAction<string>>;
  setEvents: Dispatch<SetStateAction<AppEvent[]>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const { logged, session, setProvider, setEvents, setError } = opts;
  useEffect(() => {
    if (session) {
      sessionStorage.setItem("robo-conversation", session);
    } else {
      sessionStorage.removeItem("robo-conversation");
    }
    if (!logged || !session) {
      return;
    }
    void api<{ conversation: { provider: string }; events: AppEvent[] }>(
      `conversations/${session}`
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
      .catch((error) => setError(error.message));
  }, [session, logged, setProvider, setEvents, setError]);
}
