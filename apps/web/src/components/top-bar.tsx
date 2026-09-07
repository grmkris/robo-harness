import type { Observation } from "@robo/domain";

import { api } from "../lib/client";
import type { Status } from "../lib/types";

export function TopBar({
  fresh,
  obs,
  accessMode,
  onLogout,
}: {
  fresh: boolean;
  obs: Observation | null | undefined;
  accessMode: Status["access_mode"];
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        RH
        <span className="brand-separator" />
        ROBO HARNESS<sup>LAB / 01</sup>
      </a>
      <div className="top-status">
        <span className={`led ${fresh ? "good" : "bad"}`} />
        {fresh ? "ROBOT CONNECTED" : "ROBOT UNAVAILABLE"}
        <span className="backend">
          {obs?.backend === "mock" ? "SIMULATED" : "SO-101"}
        </span>
      </div>
      {accessMode === "token" ? (
        <button
          className="quiet"
          onClick={() => {
            void api("logout", {}).then(onLogout);
          }}
        >
          Lock workbench ↗
        </button>
      ) : (
        <span className="eyebrow">TAILSCALE ACCESS</span>
      )}
    </header>
  );
}
