# Interactive terminal acceptance — 2026-09-08

Implementation: `aeeb3a5` on `main`. Promoted with `bun run build` and `systemctl --user restart robo-app robo-rerun`. The motor service and commissioned profile were unchanged.

- `bun run check` passed: formatting, lint, type-aware lint, TypeScript, import graph, unused-code checks, 94 Bun tests, Python lint/type checks and 78 Python tests. Existing transitional lint and Python deprecation warnings remain.
- `bun run build` passed. Ghostty is lazy-loaded; its embedded WASM produces Vite's large-chunk advisory.
- `ROBO_BROWSER_TERMINAL_ONLY=1` with the mock fixture passed through the real Docker-backed PTY: `os.isatty(0)` true, Python REPL, Ctrl-C, tab reconnect with preserved shell variables, mobile resize, explicit close, and workspace files read by the retained single-command runner after close.
- `ROBO_URL=http://100.105.51.45:8940 ROBO_REAL_TERMINAL_ONLY=1 python3 scripts/browser_real_check.py` passed on the deployed workbench. Terminal Python printed `LIVE_TTY True so101 None` using the existing program-scoped `robo_client` API.
- Before and after the live check: no controller, no fault, healthy telemetry, and identical commanded joint positions. No motion or inference was requested. Both coordinator services were active and no `robo-shell-*` containers remained.

The interactive terminal is available under **Terminal → Open terminal**. Sessions target the Netcup development container. Pi retains its separately configured single-command development-account path. See [decision 0006](decisions/0006-interactive-development-terminal.md) for boundaries and limits.
