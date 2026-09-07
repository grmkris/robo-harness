import { useState } from "react";

import { api } from "../lib/client";

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <div className="login-mark">
        RH<span>01</span>
      </div>
      <p className="eyebrow">A WORKBENCH FOR EMBODIED INTELLIGENCE</p>
      <h1>
        Meet your
        <br />
        <em>next pair of hands.</em>
      </h1>
      <p className="intro">One arm. Two cameras. An open-ended conversation.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("login", { token });
            onDone();
          } catch (error) {
            setError(
              (error as Error).message === "AUTH_REQUIRED"
                ? "Incorrect operator token"
                : (error as Error).message
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="token">Operator token</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          placeholder="Enter your local operator token"
        />
        <button className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Open workbench"} <span>↗</span>
        </button>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
      </form>
      <small>Private lab access · SO-101</small>
    </main>
  );
}
