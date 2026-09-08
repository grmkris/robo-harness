import { expect, test } from "bun:test";

import { TerminalClientMessage } from "@robo/domain";
import { Schema } from "effect";

import { dockerArguments } from "../src/shell-args";
import {
  createTerminalManager,
  type LaunchTerminal,
} from "../src/terminal-manager";
import { startHarness, tokens } from "./harness";

test("terminal input refuses strings for dimensions, oversized input and unknown commands", () => {
  const decode = Schema.decodeUnknownSync(TerminalClientMessage, {
    onExcessProperty: "error",
  });
  for (const value of [
    { type: "resize", cols: "80", rows: 24 },
    { type: "resize", cols: 10_000, rows: 24 },
    { type: "input", data: "a".repeat(16_385) },
    { type: "spawn", command: "sh" },
  ]) {
    expect(() => decode(value)).toThrow();
  }
});

test("interactive Docker command retains isolation, TTY and an independent process deadline", () => {
  const args = dockerArguments({
    id: "id",
    workspace: "/workspace/test",
    image: "image",
    uid: 1000,
    gid: 1000,
    network: "bridge",
    programUrl: "http://127.0.0.1:9",
    token: "capability",
    terminal: { lifetimeSeconds: 3600 },
  });
  expect(args).toContain("--tty");
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args[args.indexOf("--network") + 1]).toBe("bridge");
  expect(args.slice(-8)).toEqual(
    [
      "timeout",
      "--foreground",
      "--kill-after=5s",
      "3600",
      "bash",
      "--noprofile",
      "--norc",
      "-i",
    ].slice(-8)
  );
  expect(args).not.toContain("--privileged");
});

test("PTY sessions preserve shell state, resize and replay; tickets and ownership stay scoped", async () => {
  let closes = 0;
  const launch: LaunchTerminal = async ({ cols, rows, output }) => {
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_term, bytes) => output(decoder.decode(bytes, { stream: true })),
    });
    const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-i"], {
      terminal,
      env: {
        PATH: process.env["PATH"],
        PS1: "test $ ",
        TERM: "xterm-256color",
      },
    });
    return {
      write: (data) => {
        terminal.write(data);
      },
      resize: (c, r) => terminal.resize(c, r),
      exited: proc.exited,
      close: async () => {
        closes += 1;
        proc.kill("SIGKILL");
        terminal.close();
        await proc.exited;
      },
    };
  };
  const manager = createTerminalManager(launch, {
    maxSessions: 2,
    idleMs: 10_000,
    lifetimeMs: 20_000,
  });
  try {
    const session = await manager.create("alice", { cols: 80, rows: 24 });
    expect(() => manager.info("bob", session.id)).toThrow("not found");
    expect(manager.list("bob")).toHaveLength(0);
    const { ticket } = manager.ticket("alice", session.id);
    expect(manager.consumeTicket(ticket)).toBe(session.id);
    expect(manager.consumeTicket(ticket)).toBeNull();
    let text = "";
    const off = () => {};
    manager.attach(
      session.id,
      (event) => {
        if (event.type === "output") text += event.data;
      },
      off
    );
    manager.receive(session.id, { type: "resize", cols: 91, rows: 31 });
    manager.receive(session.id, {
      type: "input",
      data: "export ROBO_TEST=kept\nprintf 'RESULT:%s:' \"$ROBO_TEST\"; stty size\n",
    });
    for (
      let attempt = 0;
      attempt < 100 && !text.includes("RESULT:kept:31 91");
      attempt += 1
    )
      await Bun.sleep(10);
    expect(text).toContain("RESULT:kept:31 91");
    manager.detach(session.id, off);
    manager.attach(
      session.id,
      (event) => {
        if (event.type === "ready") text = event.replay;
      },
      () => {}
    );
    expect(text).toContain("RESULT:kept:31 91");
    await manager.closeOwner("alice");
    expect(manager.info("alice", session.id).status).toBe("exited");
    expect(closes).toBe(1);
  } finally {
    await manager.closeAll();
  }
});

test("idle session cleanup runs once and a closed session cannot accept input", async () => {
  const exited = Promise.withResolvers<number>();
  let closed = 0;
  const manager = createTerminalManager(
    async () => ({
      write: () => {},
      resize: () => {},
      exited: exited.promise,
      close: async () => {
        closed += 1;
        exited.resolve(0);
      },
    }),
    { maxSessions: 1, idleMs: 15, lifetimeMs: 1000 }
  );
  const session = await manager.create("alice", { cols: 80, rows: 24 });
  for (
    let i = 0;
    i < 50 && manager.info("alice", session.id).status !== "exited";
    i += 1
  )
    await Bun.sleep(10);
  expect(closed).toBe(1);
  expect(() =>
    manager.receive(session.id, { type: "input", data: "whoami\n" })
  ).toThrow("exited");
  await manager.closeAll();
});

test("terminal HTTP refuses agent credentials, invalid size, foreign origin and bogus tickets", async () => {
  const h = await startHarness({ withIo: false, withFixture: false });
  try {
    expect(
      (await h.request("/api/terminals", { cols: 80, rows: 24 }, tokens.agent))
        .status
    ).toBe(403);
    expect(
      (await h.request("/api/terminals", { cols: "80", rows: 24 })).status
    ).toBe(400);
    expect(
      (
        await h.request(
          "/api/terminals",
          { cols: 80, rows: 24 },
          tokens.operator,
          { Origin: "https://foreign.invalid" }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await h.request(
          "/api/terminal/connect?ticket=bogus",
          undefined,
          tokens.operator,
          { Origin: h.base }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await h.request(
          "/api/terminal/connect?ticket=bogus",
          undefined,
          tokens.operator,
          { Origin: "https://foreign.invalid" }
        )
      ).status
    ).toBe(403);
  } finally {
    await h.close();
  }
});

test("starting sessions reserve a slot and cancellation waits for acquisition cleanup", async () => {
  const acquired = Promise.withResolvers<null>();
  const exited = Promise.withResolvers<number>();
  let closes = 0;
  const manager = createTerminalManager(
    async () => {
      await acquired.promise;
      return {
        write: () => {},
        resize: () => {},
        exited: exited.promise,
        close: async () => {
          closes += 1;
          exited.resolve(0);
        },
      };
    },
    { maxSessions: 1, idleMs: 1000, lifetimeMs: 2000 }
  );
  const starting = manager.create("alice", { cols: 80, rows: 24 });
  const outcome = starting.catch(() => null);
  try {
    const duplicate = await manager
      .create("alice", { cols: 80, rows: 24 })
      .catch((error: Error) => error.message);
    expect(duplicate).toContain("already open");
    const full = await manager
      .create("bob", { cols: 80, rows: 24 })
      .catch((error: Error) => error.message);
    expect(full).toContain("slots");
    const closing = manager.closeOwner("alice");
    acquired.resolve(null);
    await closing;
    await outcome;
    expect(manager.list("alice")[0]?.status).toBe("exited");
    expect(closes).toBe(1);
  } finally {
    acquired.resolve(null);
    await manager.closeAll();
  }
});

test("session lifetime is bounded even with input, and reconnect preserves the current listener", async () => {
  const exited = Promise.withResolvers<number>();
  let closes = 0;
  const manager = createTerminalManager(
    async ({ output }) => ({
      write: (data) => output(data),
      resize: () => {},
      exited: exited.promise,
      close: async () => {
        closes += 1;
        exited.resolve(0);
      },
    }),
    { maxSessions: 1, idleMs: 1000, lifetimeMs: 60 }
  );
  try {
    const session = await manager.create("alice", { cols: 80, rows: 24 });
    let displaced = 0;
    const oldConnection = () => {
      displaced += 1;
    };
    manager.attach(session.id, () => {}, oldConnection);
    const currentConnection = () => {};
    let received = "";
    manager.attach(
      session.id,
      (event) => {
        if (event.type === "output") received += event.data;
      },
      currentConnection
    );
    manager.detach(session.id, oldConnection);
    expect(displaced).toBe(1);
    expect(() =>
      manager.receive(
        session.id,
        { type: "input", data: "stale" },
        oldConnection
      )
    ).toThrow("replaced");
    manager.receive(session.id, { type: "input", data: "still connected" });
    expect(received).toBe("still connected");
    for (
      let i = 0;
      i < 50 && manager.info("alice", session.id).status !== "exited";
      i += 1
    )
      await Bun.sleep(10);
    expect(manager.info("alice", session.id).status).toBe("exited");
    expect(closes).toBe(1);
  } finally {
    await manager.closeAll();
  }
});
