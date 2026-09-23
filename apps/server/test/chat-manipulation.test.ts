import { expect, test } from "bun:test";

import { startHarness } from "./harness";

test("every model gets general skills, fresh look images and disabled uncommissioned motion", async () => {
  const h = await startHarness({
    env: { ROBO_MANIPULATION_CONFIG: "/does-not-exist/manipulation.json" },
    modelSteps: [
      {
        calls: [
          {
            name: "look",
            input: {
              camera: "workspace",
              crop: { x: 0, y: 0, width: 100, height: 100 },
            },
          },
        ],
      },
      { calls: [{ name: "home", input: {} }] },
      { text: "The geometry is uncommissioned." },
    ],
  });
  try {
    const response = await h.request("/api/chat", {
      provider: "alibaba",
      text: "Look and return home.",
    });
    const started = await response.json();
    await h.until(
      async () => !(await h.status()).running.includes(started.session_id)
    );
    const transcript = await (
      await h.request("/api/conversations/" + started.session_id)
    ).json();
    const look = transcript.events.find(
      (event: { type: string; data: { name: string } }) =>
        event.type === "chat.tool_result" && event.data.name === "look"
    );
    expect(look.data.output.frames[0].width).toBe(400);
    expect(JSON.stringify(h.requests.at(-1))).toContain(
      "data:image/jpeg;base64,"
    );
    expect(JSON.stringify(h.requests[0])).toContain(
      "jaws close onto the fixed finger"
    );
    expect(JSON.stringify(transcript.events)).toContain(
      "CAPABILITY_UNAVAILABLE"
    );
    expect((await h.status()).observation.operation).toBeNull();
  } finally {
    await h.close();
  }
}, 15_000);
