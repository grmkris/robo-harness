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
      // The fixture reports 10 prompt + 10 completion tokens per call.
      usage: {
        input_tokens: 10 * h.requests.length,
        output_tokens: 10 * h.requests.length,
        calls: h.requests.length,
      },
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

test("visual exploration retains before and after camera evidence across measured joint probes", async () => {
  const views: FixtureStep = {
    calls: [
      { name: "observe", input: {} },
      { name: "capture", input: { camera: "workspace" } },
      { name: "capture", input: { camera: "wrist" } },
    ],
  };
  const h = await startHarness({
    modelSteps: [
      views,
      {
        calls: [
          {
            name: "move_joints",
            input: { target: { shoulder_pan: 1 }, duration_s: 1 },
          },
        ],
      },
      views,
      {
        calls: [
          {
            name: "move_joints",
            input: { target: { shoulder_pan: 1.5 }, duration_s: 1 },
          },
        ],
      },
      views,
      {
        text: "Compared camera evidence from two measured joint probes; no grasp claimed.",
      },
    ],
  });
  try {
    const response = await h.request("/api/chat", {
      provider: "alibaba",
      model: "fixture",
      text: "Explore how a small shoulder movement changes the camera view, and retain the observations.",
    });
    expect(response.status).toBe(200);
    const { session_id: id } = (await response.json()) as {
      session_id: string;
    };
    const result = await transcript(h, id);
    expect(
      result.events.filter((event) => event.type === "chat.tool_error")
    ).toEqual([]);
    const observations = result.events
      .filter(
        (event) =>
          event.type === "chat.tool_result" && event.data["name"] === "observe"
      )
      .map(
        (event) =>
          event.data["output"] as {
            measured: { shoulder_pan: number };
            operation: { status: string } | null;
          }
      );
    expect(observations).toHaveLength(3);
    expect(observations[0]?.measured.shoulder_pan).toBe(0);
    expect(observations[1]?.operation?.status).toBe("completed");
    expect(observations[1]?.measured.shoulder_pan).toBeCloseTo(1, 2);
    expect(observations[2]?.measured.shoulder_pan).toBeCloseTo(1.5, 2);
    for (const [requestIndex, imageCount] of [
      [1, 2],
      [3, 4],
      [5, 6],
    ] as const) {
      const messages = JSON.stringify(h.requests[requestIndex]?.["messages"]);
      expect([...messages.matchAll(/data:image\/jpeg;base64,/g)]).toHaveLength(
        imageCount
      );
    }
    const captureIds = result.events
      .filter(
        (event) =>
          event.type === "chat.tool_result" && event.data["name"] === "capture"
      )
      .map((event) => (event.data["output"] as { id: string }).id);
    expect(new Set(captureIds).size).toBe(6);
    expect(
      result.events.find((event) => event.type === "chat.finished")?.data[
        "completed_actions"
      ]
    ).toBe(2);
    await h.until(async () => (await h.status()).observation.operator === null);
  } finally {
    await h.close();
  }
}, 15_000);

test("chat stores exact camera pixels outside events and serves authenticated historical captures", async () => {
  const h = await startHarness({
    modelSteps: [
      { calls: [{ name: "capture", input: { camera: "workspace" } }] },
      { text: "Captured." },
    ],
  });
  try {
    const id = await start(h);
    const result = await transcript(h, id);
    const output = result.events.find(
      (e) => e.type === "chat.tool_result" && e.data["name"] === "capture"
    )?.data["output"] as { id: string; image_id: string };
    expect(output.image_id).toBeString();
    expect(JSON.stringify(result)).not.toContain("base64");
    const url = `/api/chat-images/${output.image_id}`;
    const response = await h.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Id")).toBe(output.id);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = Buffer.from(await response.arrayBuffer());
    // The stored bytes must be the exact image delivered to the model.
    expect(JSON.stringify(h.requests.at(-1)?.["messages"])).toContain(
      bytes.toString("base64")
    );
    await h.call("capture", { camera: "workspace" });
    const reopened = await h.request(`/api/conversations/${id}`);
    expect(JSON.stringify(await reopened.json())).toContain(output.image_id);
    expect(
      Buffer.from(await (await h.request(url)).arrayBuffer()).equals(bytes)
    ).toBe(true);
    expect((await fetch(h.base + url)).status).toBe(401);
    expect((await h.request("/api/chat-images/not-an-id")).status).toBe(400);
    expect(
      (await h.request(`/api/chat-images/${crypto.randomUUID()}`)).status
    ).toBe(404);
  } finally {
    await h.close();
  }
}, 15_000);

test("text-only models still save captures for the operator without receiving image input", async () => {
  const h = await startHarness({
    env: { ROBO_ALIBABA_VISION: "0" },
    modelSteps: [
      { calls: [{ name: "capture", input: { camera: "wrist" } }] },
      { text: "Metadata received." },
    ],
  });
  try {
    const result = await transcript(h, await start(h));
    const output = result.events.find((e) => e.type === "chat.tool_result")
      ?.data["output"] as { image_id: string };
    expect(output.image_id).toBeString();
    expect(
      (await h.request(`/api/chat-images/${output.image_id}`)).status
    ).toBe(200);
    expect(JSON.stringify(h.requests)).not.toContain("data:image");
  } finally {
    await h.close();
  }
}, 15_000);

test("assistant explanations precede their tool call and result without duplication", async () => {
  const h = await startHarness({
    modelSteps: [
      {
        text: "I will capture the workspace now.",
        calls: [{ name: "capture", input: { camera: "workspace" } }],
      },
      { text: "The capture is visible." },
    ],
  });
  try {
    const result = await transcript(h, await start(h));
    const events = result.events.filter(
      (event) =>
        event.type === "chat.tool" ||
        event.type === "chat.tool_result" ||
        (event.type === "chat.message" && event.data["role"] === "assistant")
    );
    expect(events.map((event) => event.type)).toEqual([
      "chat.message",
      "chat.tool",
      "chat.tool_result",
      "chat.message",
    ]);
    expect(events[0]?.data["text"]).toBe("I will capture the workspace now.");
    expect(events[3]?.data["text"]).toBe("The capture is visible.");
  } finally {
    await h.close();
  }
}, 15_000);

test("a bench run through the gateway provider takes its own step cap and skill text", async () => {
  const h = await startHarness({
    modelSteps: [move(), move(), { text: "Stopped at the cap." }],
  });
  try {
    const response = await h.request("/api/chat", {
      provider: "cliproxy",
      model: "fixture-gateway",
      text: "Move the gripper slightly and report measured completion.",
      step_cap: 2,
      stall_ms: 20_000,
      system_append: "BENCH-SKILL-DOC: observe before acting.",
    });
    expect(response.status).toBe(200);
    const started = (await response.json()) as {
      session_id: string;
      run_id: string;
      event_id: number;
    };
    expect(started.event_id).toBeGreaterThan(0);
    const result = await transcript(h, started.session_id);
    // Step 2 of 2 is the tools-disabled summary.
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[0]?.["messages"])).toContain(
      "BENCH-SKILL-DOC: observe before acting."
    );
    expect(JSON.stringify(h.requests[0]?.["messages"])).toContain("step 1/2");
    expect(h.requests[1]?.["tool_choice"]).toBe("none");
    // The gateway provider never sends the flag some upstreams reject.
    expect(h.requests[0]).not.toHaveProperty("parallel_tool_calls");
    const finished = result.events.find(
      (event) => event.type === "chat.finished"
    )?.data;
    expect(finished).toMatchObject({
      run_id: started.run_id,
      steps: 2,
      usage: { input_tokens: 20, output_tokens: 20, calls: 2 },
    });
  } finally {
    await h.close();
  }
}, 20_000);

test("bench run options are bounded and strictly validated", async () => {
  const h = await startHarness({ withIo: false });
  try {
    const body = { provider: "cliproxy", text: "hi" };
    for (const extra of [
      { step_cap: 0 },
      { step_cap: 201 },
      { step_cap: 2.5 },
      { stall_ms: 100 },
      { system_append: "" },
      { system_append: "x".repeat(32_001) },
      { unknown_option: true },
    ]) {
      expect((await h.request("/api/chat", { ...body, ...extra })).status).toBe(
        400
      );
    }
  } finally {
    await h.close();
  }
}, 20_000);
