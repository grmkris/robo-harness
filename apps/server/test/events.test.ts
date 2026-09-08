import { expect, test } from "bun:test";

import { startHarness } from "./harness";

test("SSE exposes durable IDs and resumes strictly after Last-Event-ID", async () => {
  const h = await startHarness();
  try {
    await h.call("stop");
    const response = await h.request("/api/events");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    await reader?.cancel();
    const id = Number(/id: (?<id>\d+)/u.exec(text)?.groups?.["id"]);
    expect(id).toBeGreaterThan(0);
    expect(text).toContain(`"id":${id}`);
    await h.call("stop");
    const resumed = await h.request("/api/events", undefined, undefined, {
      "Last-Event-ID": String(id),
    });
    const nextReader = resumed.body?.getReader();
    const next = await nextReader?.read();
    const replay = new TextDecoder().decode(next?.value);
    await nextReader?.cancel();
    const ids = [...replay.matchAll(/id: (?<id>\d+)/gu)].map((match) =>
      Number(match.groups?.["id"])
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((value) => value > id)).toBe(true);
  } finally {
    await h.close();
  }
}, 15_000);
