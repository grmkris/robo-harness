import type { Observation } from "@robo/domain";

import { api } from "../lib/client";
import type { Status } from "../lib/types";

export function TopBar({
  fresh,
  obs,
  accessMode,
  onLogout,
  halt,
}: {
  fresh: boolean;
  obs: Observation | null | undefined;
  accessMode: Status["access_mode"];
  onLogout: () => void;
  halt: () => Promise<void>;
}) {
  return (
    <header className="topbar">
      <h1>
        <a className="brand" href="/">
          Robo Harness
        </a>
      </h1>
      <div className="top-status">
        <span className={`led ${fresh ? "good" : "bad"}`} />
        {obs?.fault ? "Control stopped" : fresh ? "Connected" : "Unavailable"}
        <span className="backend">
          {obs?.backend === "mock" ? "Mock" : "SO-101"}
        </span>
      </div>
      {accessMode === "token" ? (
        <button
          className="quiet"
          onClick={() => {
            void api("logout", {}).then(onLogout);
          }}
        >
          Lock
        </button>
      ) : null}
      <button
        type="button"
        className="stop-button"
        onClick={() => {
          void halt();
        }}
      >
        ■ STOP / HOLD
      </button>
    </header>
  );
}
