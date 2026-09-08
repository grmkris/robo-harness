import { expect, test } from "bun:test";

import { startHarness, type FixtureStep, type Harness } from "./harness";

const start = async (h: Harness) => {
  const response = await h.request("/api/chat", {
    provider: "alibaba",
    model: "fixture",
    text: "Move the gripper slightly and report measured completion.",
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { session_id: string };
  return result.session_id;
};
const transcript = async (h: Harness, id: string) => {
  await h.until(async () => !(await h.status()).running.includes(id), 12_000);
  return (await (await h.request(`/api/conversations/${id}`)).json()) as {
    events: { type: string; data: Record<string, unknown> }[];
  };
};
const move = (duration = 1): FixtureStep => ({
  calls: [
    {
      name: "move_joints",
      input: { target: { gripper: 42 }, duration_s: duration },
    },
  ],
});

test("chat moves after slow reasoning with one action, measured completion, and released ownership", async () => {
  const h = await startHarness({
    modelSteps: [
      { calls: [{ name: "observe", input: {} }] },
      { ...move(), delayMs: 3500 },
      { text: "Measured completion confirmed." },
    ],
  });
  try {
    const id = await start(h);
    const result = await transcript(h, id);
    expect(result.events.filter((e) => e.type === "chat.tool_error")).toEqual(
      []
    );
    await h.until(async () => (await h.status()).observation.operator === null);
    const state = await h.status();
    expect(state.observation.operation.status).toBe("completed");
    expect(Math.abs(state.observation.measured.gripper - 42)).toBeLessThan(0.8);
    expect(state.observation.operator).toBeNull();
    expect(
      result.events.some(
        (e) => e.type === "chat.motion" && e.data["phase"] === "finished"
      )
    ).toBe(true);
    expect(h.requests[0]?.["parallel_tool_calls"]).toBe(false);
    const wire = JSON.stringify(h.requests[0]?.["tools"]);
    expect(wire).toContain('"move_joints"');
    expect(wire).not.toContain('"acquire"');
    expect(wire).not.toContain('"takeover"');
  } finally {
    await h.close();
  }
}, 20_000);

test("same-response moves cannot queue a second physical operation", async () => {
  const calls = [
    ...(move().calls ?? []),
    { name: "move_joints", input: { target: { gripper: 44 }, duration_s: 1 } },
  ];
  const h = await startHarness({
    modelSteps: [{ calls }, { text: "Only the first action ran." }],
  });
  try {
    const result = await transcript(h, await start(h));
    expect(
      result.events.filter(
        (e) => e.type === "chat.tool_error" && e.data["code"] === "MOTION_BUSY"
      )
    ).toHaveLength(1);
    expect((await h.status()).observation.operation.target.gripper).toBe(42);
    expect(
      result.events.filter(
        (e) => e.type === "chat.motion" && e.data["phase"] === "finished"
      )
    ).toHaveLength(1);
  } finally {
    await h.close();
  }
}, 15_000);

test("invalid strings are visible, and recovery with numeric input succeeds", async () => {
  const h = await startHarness({
    modelSteps: [
      {
        calls: [
          {
            name: "move_joints",
            input: { target: { gripper: 42 }, duration_s: "1" },
          },
        ],
      },
      move(),
      { text: "Fixed arguments; completed." },
    ],
  });
  try {
    const result = await transcript(h, await start(h));
    const error = result.events.find((e) => e.type === "chat.tool_error");
    expect(error?.data["code"]).toBe("INVALID_INPUT");
    expect(error?.data["message"]).toContain("duration_s");
    expect(error?.data["tool_call_id"]).toBeString();
    const metrics = result.events.find((e) => e.type === "chat.finished")?.data;
    expect(metrics).toMatchObject({
      tool_calls: 2,
      invalid_inputs: 1,
      completed_actions: 1,
      first_tool_input_valid: false,
    });
    await h.until(
      async () =>
        (await h.status()).observation.operation?.status === "completed"
    );
  } finally {
    await h.close();
  }
}, 15_000);

test("cancelling a running chat action cancels motion and releases ownership", async () => {
  const h = await startHarness({ modelSteps: [move(5), { text: "done" }] });
  try {
    const id = await start(h);
    await h.until(
      async () => (await h.status()).observation.operation?.status === "running"
    );
    await h.request("/api/chat/cancel", { id });
    await transcript(h, id);
    await h.until(async () => (await h.status()).observation.operator === null);
    expect((await h.status()).observation.operation.status).toBe("cancelled");
  } finally {
    await h.close();
  }
}, 15_000);

test("human takeover cancels chat action without cleanup revoking human control", async () => {
  const h = await startHarness({
    modelSteps: [move(5), move(), { text: "done" }],
  });
  try {
    const id = await start(h);
    await h.until(
      async () => (await h.status()).observation.operation?.status === "running"
    );
    expect(
      (await h.call("acquire", { mode: "human", takeover: true })).status
    ).toBe(200);
    await transcript(h, id);
    await h.until(
      async () => (await h.status()).observation.operator?.mode === "human"
    );
    expect((await h.call("renew")).status).toBe(200);
    const state = await h.status();
    expect(state.observation.operator.mode).toBe("human");
    expect(state.observation.operation.status).toBe("cancelled");
    expect(h.requests.length).toBe(1);
  } finally {
    await h.close();
  }
}, 15_000);

test("capability discovery is required for optional actions and image input is delivered", async () => {
  const h = await startHarness({
    modelSteps: [
      { calls: [{ name: "shell", input: { command: "echo denied" } }] },
      { calls: [{ name: "capture", input: { camera: "workspace" } }] },
      { text: "Image received." },
    ],
  });
  try {
    const result = await transcript(h, await start(h));
    expect(
      result.events.some(
        (e) =>
          e.type === "chat.tool_error" &&
          e.data["code"] === "TOOL_NOT_AVAILABLE"
      )
    ).toBe(true);
    expect(JSON.stringify(h.requests.at(-1)?.["messages"])).toContain(
      "data:image/jpeg;base64,"
    );
    const state = await h.status();
    expect(
      state.providers.find((p: { id: string }) => p.id === "alibaba")
        .capabilities[0].image_input
    ).toBe(true);
  } finally {
    await h.close();
  }
}, 15_000);

test("TanStack provider failures are not retried automatically", async () => {
  const h = await startHarness({
    modelSteps: [{ status: 500 }, { text: "must not be requested" }],
  });
  try {
    const result = await transcript(h, await start(h));
    expect(h.requests).toHaveLength(1);
    expect(result.events.some((event) => event.type === "chat.error")).toBe(
      true
    );
    expect(result.events.some((event) => event.type === "chat.tool")).toBe(
      false
    );
  } finally {
    await h.close();
  }
}, 15_000);

test("optional numeric defaults remain optional on the wire and validate without coercion", async () => {
  const h = await startHarness({
    modelSteps: [
      {
        calls: [
          {
            name: "move_joints",
            input: { target: { gripper: 42 }, duration_s: null },
          },
        ],
      },
      {
        calls: [
          {
            name: "move_joints",
            input: { target: { gripper: 42 }, unexpected: true },
          },
        ],
      },
      { calls: [{ name: "move_joints", input: { target: { gripper: 42 } } }] },
      { text: "Measured completion with default duration." },
    ],
  });
  try {
    const result = await transcript(h, await start(h));
    expect(
      result.events.filter((event) => event.type === "chat.tool_error")
    ).toHaveLength(2);
    const finished = result.events.find(
      (event) => event.type === "chat.finished"
    )?.data;
    expect(finished?.["completed_actions"]).toBe(1);
    const tools = h.requests[0]?.["tools"] as {
      function: {
        name: string;
        parameters: {
          required?: string[];
          properties: Record<string, unknown>;
        };
      };
    }[];
    const schema = tools.find((tool) => tool.function.name === "move_joints")
      ?.function.parameters;
    expect(schema?.required).not.toContain("duration_s");
    expect(schema?.properties["duration_s"]).toMatchObject({
      type: "number",
      minimum: 0.1,
      maximum: 10,
    });
    // Status is sampled; the actual release can precede the next published observation.
    await h.until(async () => (await h.status()).observation.operator === null);
    expect((await h.status()).observation.operator).toBeNull();
  } finally {
    await h.close();
  }
}, 15_000);
