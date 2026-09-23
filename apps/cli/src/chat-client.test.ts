import { afterEach, expect, test } from "bun:test";

import { runChat } from "./chat-client";

const session = "7b3f9a52-1c0e-4c1d-9a61-2f8f3c6f0e11";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

/** A coordinator stand-in: accepts one chat, then streams scripted events
 *  (an unrelated session's first) and records every request it saw. */
const coordinator = (finishOnCancel = false, neverFinish = false) => {
  const seen: { path: string; auth: string | null; body: unknown }[] = [];
  const events: { id: number; type: string; data: Record<string, unknown> }[] =
    [
      {
        id: 41,
        type: "chat.finished",
        data: { session_id: "other", run_id: "r" },
      },
      {
        id: 42,
        type: "chat.message",
        data: { session_id: session, role: "user", text: "go" },
      },
      {
        id: 43,
        type: "chat.tool",
        data: { session_id: session, name: "observe" },
      },
      {
        id: 44,
        type: "chat.message",
        data: { session_id: session, role: "assistant", text: "Done." },
      },
      {
        id: 45,
        type: "chat.finished",
        data: {
          session_id: session,
          run_id: "run-1",
          steps: 2,
          usage: { input_tokens: 30, output_tokens: 7, calls: 2 },
        },
      },
    ];
  let cancelled = Promise.withResolvers<null>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname + url.search,
        auth: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json() : null,
      });
      if (url.pathname === "/api/chat")
        return Response.json({
          session_id: session,
          run_id: "run-1",
          event_id: 42,
        });
      if (url.pathname === "/api/chat/cancel") {
        cancelled.resolve(null);
        return Response.json({ cancelled: true });
      }
      const body = new ReadableStream({
        async start(controller) {
          const after = Number(url.searchParams.get("after"));
          const send = (event: (typeof events)[number]) => {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`
              )
            );
          };
          // Replay from the cursor, plus the older event just before it, so
          // the client has to filter a foreign session out.
          const script = events.filter((event) => event.id > after - 1);
          for (const event of script.slice(0, -1)) send(event);
          if (finishOnCancel) {
            await cancelled.promise;
            cancelled = Promise.withResolvers<null>();
            send({
              id: 46,
              type: "chat.error",
              data: {
                session_id: session,
                code: "CANCELLED",
                message: "Operator stopped this run.",
              },
            });
          }
          const last = script.at(-1);
          if (last && !neverFinish)
            send(finishOnCancel ? { ...last, id: 47 } : last);
        },
      });
      return new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${String(server.port)}`, seen };
};

test("a turn resolves with its own chat.finished, usage and last reply", async () => {
  const { base, seen } = coordinator();
  process.env["ROBO_TOKEN"] = "operator-token-for-the-fixture-only";
  try {
    const summary = await runChat({
      baseUrl: base,
      provider: "cliproxy",
      model: "grok-4.7",
      text: "go",
      stepCap: 6,
      systemAppend: "skill",
    });
    expect(summary).toMatchObject({
      session_id: session,
      run_id: "run-1",
      provider: "cliproxy",
      model: "grok-4.7",
      error: null,
      final_text: "Done.",
      usage: { input_tokens: 30, output_tokens: 7, calls: 2 },
    });
    expect(seen[0]?.body).toEqual({
      provider: "cliproxy",
      model: "grok-4.7",
      text: "go",
      step_cap: 6,
      system_append: "skill",
    });
    expect(seen[0]?.auth).toBe("Bearer operator-token-for-the-fixture-only");
    expect(seen[1]?.path).toBe("/api/events?after=41");
  } finally {
    Reflect.deleteProperty(process.env, "ROBO_TOKEN");
  }
});

test("aborting cancels the turn on the coordinator and still returns its summary", async () => {
  const { base, seen } = coordinator(true);
  // No token anywhere: the request relies on address trust (and the real
  // operator token on this machine is never read into a test).
  process.env["ROBO_TOKEN_FILE"] = "/nonexistent/operator-token";
  try {
    const abort = new AbortController();
    const summary = await runChat({
      baseUrl: base,
      provider: "cliproxy",
      text: "go",
      signal: abort.signal,
      onEvent: (event) => {
        if (event.type === "chat.tool") abort.abort();
      },
    });
    expect(seen[0]?.auth).toBeNull();
    expect(seen.some((entry) => entry.path === "/api/chat/cancel")).toBe(true);
    expect(summary.error).toEqual({
      code: "CANCELLED",
      message: "Operator stopped this run.",
    });
  } finally {
    Reflect.deleteProperty(process.env, "ROBO_TOKEN_FILE");
  }
});

test("a pre-aborted client never starts a turn", async () => {
  const { base, seen } = coordinator();
  const abort = new AbortController();
  abort.abort(new Error("already stopped"));
  await Promise.resolve(
    expect(
      runChat({
        baseUrl: base,
        provider: "cliproxy",
        text: "go",
        signal: abort.signal,
      })
    ).rejects.toThrow("already stopped")
  );
  expect(seen).toHaveLength(0);
});

test("cancellation drain is bounded when the terminal event is lost", async () => {
  const { base, seen } = coordinator(true, true);
  const abort = new AbortController();
  process.env["ROBO_TOKEN_FILE"] = "/nonexistent/operator-token";
  try {
    const started = performance.now();
    await Promise.resolve(
      expect(
        runChat({
          baseUrl: base,
          provider: "cliproxy",
          text: "go",
          signal: abort.signal,
          cancelWaitMs: 50,
          onEvent: (event) => {
            if (event.type === "chat.tool") abort.abort();
          },
        })
      ).rejects.toThrow("Cancellation outcome unverified")
    );
    expect(performance.now() - started).toBeLessThan(1500);
    expect(
      seen.filter((entry) => entry.path === "/api/chat/cancel")
    ).toHaveLength(1);
  } finally {
    Reflect.deleteProperty(process.env, "ROBO_TOKEN_FILE");
  }
});
