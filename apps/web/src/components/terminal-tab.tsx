import type { Dispatch, SetStateAction } from "react";

export function TerminalTab({
  command,
  setCommand,
  shellHost,
  setShellHost,
  pending,
  run,
  shellResult,
  setShellResult,
}: {
  command: string;
  setCommand: Dispatch<SetStateAction<string>>;
  shellHost: string;
  setShellHost: Dispatch<SetStateAction<string>>;
  pending: boolean;
  run: (name: string, input?: unknown) => Promise<unknown>;
  shellResult: string;
  setShellResult: Dispatch<SetStateAction<string>>;
}) {
  return (
    <div className="tab-body">
      <p className="eyebrow">DEVELOPMENT WORKSPACE</p>
      <h2>Try a program.</h2>
      <p className="muted">
        Commands run in a development environment. Activating hardware changes
        stays a reviewed step.
      </p>
      <select
        aria-label="Shell host"
        value={shellHost}
        onChange={(e) => setShellHost(e.target.value)}
      >
        <option value="netcup">Netcup container</option>
        <option value="pi">Pi development account</option>
      </select>
      <textarea
        className="code-input"
        aria-label="Shell command"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        rows={7}
      />
      <button
        className="primary"
        disabled={pending || !command.trim()}
        onClick={async () => {
          const out = await run("shell", {
            command,
            host: shellHost,
            timeout_s: 30,
          });
          if (out) {
            setShellResult(JSON.stringify(out, null, 2));
          }
        }}
      >
        Run command ↗
      </button>
      <pre className="terminal-output">
        {shellResult || "$ Ready when you are."}
      </pre>
    </div>
  );
}
