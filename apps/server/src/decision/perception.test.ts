import { expect, test } from "bun:test";

import type { Frame } from "@robo/domain";
import jpeg from "jpeg-js";

import { whiteBlob } from "./blob";
import { fixtureObservation } from "./fixtures";
import { pickupPerception } from "./perception";
import { describeScene } from "./scene";

/** A dark frame with a bright rectangle, JPEG-encoded like the cameras. */
const frame = (
  camera: string,
  rect: [number, number, number, number] | null
): Frame => {
  const width = 640;
  const height = 480;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside =
        rect !== null &&
        x >= rect[0] &&
        x < rect[2] &&
        y >= rect[1] &&
        y < rect[3];
      const offset = (y * width + x) * 4;
      data[offset] = inside ? 50 : 2;
      data[offset + 1] = inside ? 170 : 8;
      data[offset + 2] = inside ? 200 : 16;
      data[offset + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 80);
  return {
    id: `${camera}-1`,
    camera,
    seq: 1,
    monotonic_s: 1,
    wall_time_ms: 1,
    clock_domain: "boot",
    age_ms: 25,
    width,
    height,
    media_type: "image/jpeg",
    base64: Buffer.from(encoded.data).toString("base64"),
  };
};

test("the blob centre and box are image offsets of the bright piece", () => {
  const detection = whiteBlob(frame("wrist", [120, 300, 280, 420]));
  expect(detection["visible"]).toBe(true);
  expect(detection["center_x"]).toBeCloseTo(-0.375, 1);
  expect(detection["center_y"]).toBeCloseTo(0.5, 1);
  expect(whiteBlob(frame("wrist", null))["visible"]).toBe(false);
  const table = whiteBlob(frame("wrist", [480, 0, 640, 480]));
  expect(table["visible"]).toBe(false);
  expect(table["background"]).toBe(true);
  // A wedge of table at the mat edge: modest span, but it runs off the frame.
  const wedge = whiteBlob(frame("wrist", [420, 300, 640, 480]));
  expect(wedge["visible"]).toBe(false);
  expect(wedge["background"]).toBe(true);
  expect(wedge["touches_edge"]).toBe(true);
});

test("scene replies are parsed strictly and failures stay short", async () => {
  const reply = (content: string) => () =>
    Promise.resolve(Response.json({ choices: [{ message: { content } }] }));
  const config = {
    url: "http://scene",
    key: "k",
    model: "test-vlm",
    timeoutMs: 1000,
  };
  const good = await describeScene(
    config,
    [frame("workspace", null), frame("wrist", [0, 0, 10, 10])],
    new AbortController().signal,
    reply(
      'Here: {"piece_visible_workspace":true,"piece_visible_wrist":true,"gripper_open":true,"piece_between_jaws":false,"piece_lifted":false,"piece_point_wrist":[0.3,0.8],"suggested_subgoal":"center","confidence":"medium","notes":"left of centre"}'
    )
  );
  expect(good["ok"]).toBe(true);
  expect(good["suggested_subgoal"]).toBe("center");
  const bad = await describeScene(
    config,
    [frame("wrist", null)],
    new AbortController().signal,
    reply("I cannot tell")
  );
  expect(bad["ok"]).toBe(false);
});

test("pickup perception reports the wrist blob and the gripper stall evidence", async () => {
  const perception = pickupPerception({
    capture: (camera) => Promise.resolve(frame(camera, [260, 300, 380, 460])),
    scene: null,
    sceneEvery: 5,
  });
  const open = fixtureObservation();
  const detections = await perception.perceive(
    fixtureObservation({
      measured: { ...open.measured, gripper: 12 },
      commanded: { ...open.commanded, gripper: 4 },
    }),
    new AbortController().signal
  );
  expect(
    detections.find((d) => d.source === "white-blob/v1")?.["visible"]
  ).toBe(true);
  expect(
    detections.find((d) => d.source === "grasp-check/v1")?.["likely_holding"]
  ).toBe(true);
});
