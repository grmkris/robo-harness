import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { tool } from "../lib/client";

export function useLease(
  own: boolean,
  setError: Dispatch<SetStateAction<string>>
) {
  useEffect(() => {
    if (!own) {
      return;
    }
    const id = setInterval(() => {
      void tool("renew").catch((error) => setError(error.message));
    }, 900);
    return () => clearInterval(id);
  }, [own, setError]);
}
