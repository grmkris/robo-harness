import type { Observation, ProviderInfo } from "@robo/domain";

export interface Status {
  access_mode: "tailnet" | "token";
  observation: Observation | null;
  robot_error: string | null;
  received_at: number;
  controller: string;
  running: string[];
  providers: ProviderInfo[];
  conversations: Array<{ id: string; provider: string; created: number }>;
  recording: {
    id: string;
    label: string;
    frames: number;
    state: string;
  } | null;
  telemetry: {
    online: boolean;
    error: string | null;
    dropped: number;
    version: string;
  };
  clock: { uncertainty_ms: number };
  perception: { configured: boolean; provider: string; cost_usd: number };
  budget: { limit_usd: number; spent_usd: number } | null;
}
export interface Recorded {
  id: string;
  label: string;
  created: number;
  frames: number;
  state: string;
  error: string | null;
}
