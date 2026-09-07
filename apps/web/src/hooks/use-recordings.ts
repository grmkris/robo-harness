import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { api } from "../lib/client";
import type { Recorded, Status } from "../lib/types";

export function useRecordings(opts: {
  tab: string;
  logged: boolean | null;
  recording: Status["recording"];
  setError: Dispatch<SetStateAction<string>>;
}) {
  const { tab, logged, recording, setError } = opts;
  const [records, setRecords] = useState<Recorded[]>([]);
  useEffect(() => {
    if (tab !== "recordings" || !logged) {
      return;
    }
    void api<Recorded[]>("recordings")
      .then(setRecords)
      .catch((error) => setError(error.message));
  }, [tab, logged, recording, setError]);
  return { records };
}
