import { ToolFailure } from "./tool-errors";

let control = new AbortController();

export const agentControlSignal = (): AbortSignal => control.signal;

export const revokeAgentControl = (detail: string): void => {
  control.abort(new ToolFailure({ code: "CONTROL_REVOKED", detail }));
  control = new AbortController();
};
