import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { tool } from "../lib/client";

export function useRun(opts: {
  refresh: () => Promise<void>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const { refresh, setError } = opts;
  const [pending, setPending] = useState(false);
  const run = async (name: string, input: unknown = {}) => {
    setPending(true);
    setError("");
    try {
      const result = await tool(name, input);
      await refresh();
      return result;
    } catch (error) {
      setError((error as Error).message);
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
    } catch (error) {
      setError(
        "Stop command was not acknowledged: " + (error as Error).message
      );
    }
  };
  return { pending, run, halt };
}
