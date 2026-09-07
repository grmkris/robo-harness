# @robo/server

The coordinator process. Bun hosts it; it owns the control leases, the ten-hertz sampler, chat runs and the MCP surface. It talks to the motors only through the Python I/O service over HTTP, never directly, and decodes every response at that boundary. Imports the value types from `@robo/domain` and the tool schemas from `@robo/protocol`; keeps its own `zod` for request-body validation. Tests spawn the real process on port 0 through `test/harness.ts`; add cases there, not fixed ports.
