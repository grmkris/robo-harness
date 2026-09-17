# @robo/cli

The operator CLI, the stdio MCP server, the real-arm smoke, and `src/jev.ts` (`bun run jev`), the client for coordinator decision runs. It speaks the wire contract through `@robo/protocol` and reaches a running coordinator over HTTP with `ROBO_URL`; it holds no hardware or provider credentials of its own.
