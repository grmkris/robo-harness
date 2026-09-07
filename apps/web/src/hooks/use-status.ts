import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/client";
import type { Status } from "../lib/types";

export function useStatus() {
  const [logged, setLogged] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [viewTick, setViewTick] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Status>("status");
      setStatus(next);
      setLogged(true);
    } catch (error) {
      if ((error as Error).message === "AUTH_REQUIRED") setLogged(false);
      else setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    if (logged === false) {
      return;
    }
    void refresh();
    const id = setInterval(() => {
      void refresh();
      setViewTick((v) => v + 1);
    }, 700);
    return () => clearInterval(id);
  }, [refresh, logged]);
  return { logged, setLogged, status, error, setError, viewTick, refresh };
}
