/** Offline fixture only: reads archived evidence and never imports robot/provider services. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Frame } from "@robo/domain";
import { Schema } from "effect";

import { frameEvidence, judgeTrial, TrialEvidence } from "./bench-judge";
import { decodeManipulationConfig } from "./manipulation-config";

const Proof = Schema.Struct({
  value: Schema.NullOr(Schema.Boolean),
  frame_ids: Schema.Array(Schema.String),
  method: Schema.String.check(Schema.isMinLength(1)),
});
const ReplayManifest = Schema.Struct({
  kind: Schema.Literals(["scored", "smoke", "reset", "offline_fixture"]),
  config: Schema.String,
  before: Schema.String,
  after: Schema.String,
  lift_workspace: Schema.NullOr(Schema.String),
  lift_wrist: Schema.NullOr(Schema.String),
  target_xy_m: TrialEvidence.fields.target_xy_m,
  gripper_stalled_at: TrialEvidence.fields.gripper_stalled_at,
  claimed_success: TrialEvidence.fields.claimed_success,
  failure_hint: TrialEvidence.fields.failure_hint,
  sam: Schema.NullOr(Proof),
  vlm: Schema.NullOr(Proof),
});

const ArchivedFrame = Schema.Struct({
  ...Frame.fields,
  base64: Schema.optionalKey(Schema.String),
  image: Schema.String.check(Schema.isPattern(/^(?:workspace|wrist)\.jpg$/u)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const readFrame = async (path: string): Promise<Frame> => {
  const metadata = Schema.decodeUnknownSync(ArchivedFrame)(
    JSON.parse(await readFile(path, "utf-8"))
  );
  if (metadata.image !== `${metadata.camera}.jpg`)
    throw new Error("Archived camera/image mismatch");
  const bytes = await readFile(resolve(dirname(path), metadata.image));
  if (digest(bytes) !== metadata.sha256)
    throw new Error(`Frame hash mismatch: ${metadata.id}`);
  if (metadata.age_ms < 0 || metadata.age_ms > 500)
    throw new Error(`Frame was stale at capture: ${metadata.id}`);
  return Schema.decodeUnknownSync(Frame)({
    ...metadata,
    base64: bytes.toString("base64"),
  });
};

const proofValue = (
  proof: typeof Proof.Type | null,
  required: readonly (string | undefined)[]
) => {
  if (
    !proof ||
    required.some((id) => id === undefined || !proof.frame_ids.includes(id))
  )
    return null;
  return proof.value;
};

/** Missing verification stays null. The replay cannot prove live trial admission. */
export const replayTrial = async (path: string) => {
  const manifest = Schema.decodeUnknownSync(ReplayManifest, {
    onExcessProperty: "error",
  })(JSON.parse(await readFile(path, "utf-8")));
  const root = dirname(resolve(path));
  const configText = await readFile(resolve(root, manifest.config), "utf-8");
  const config = decodeManipulationConfig(JSON.parse(configText));
  const [before, after, liftWorkspace, liftWrist] = await Promise.all([
    readFrame(resolve(root, manifest.before)),
    readFrame(resolve(root, manifest.after)),
    manifest.lift_workspace === null
      ? null
      : readFrame(resolve(root, manifest.lift_workspace)),
    manifest.lift_wrist === null
      ? null
      : readFrame(resolve(root, manifest.lift_wrist)),
  ]);
  if (
    before.camera !== "workspace" ||
    after.camera !== "workspace" ||
    (liftWorkspace !== null && liftWorkspace.camera !== "workspace") ||
    (liftWrist !== null && liftWrist.camera !== "wrist")
  ) {
    throw new Error("Replay evidence has the wrong camera role");
  }
  const frames = [before, after, liftWorkspace, liftWrist].filter(
    (frame) => frame !== null
  );
  if (frames.some((frame) => frame.clock_domain !== before.clock_domain)) {
    throw new Error("Replay evidence crosses robot clocks");
  }
  if (
    before.id === after.id ||
    before.monotonic_s >= after.monotonic_s ||
    before.seq >= after.seq
  ) {
    throw new Error("Before/after evidence is reused or out of order");
  }
  for (const frame of [liftWorkspace, liftWrist]) {
    if (
      frame &&
      (frame.monotonic_s <= before.monotonic_s ||
        frame.monotonic_s >= after.monotonic_s)
    ) {
      throw new Error("Lift evidence is outside the trial interval");
    }
  }
  const cc = frameEvidence({ before, after, liftWorkspace, liftWrist, config });
  const evidence: TrialEvidence = {
    target_xy_m: manifest.target_xy_m,
    final_xy_m: config.commissioned ? cc.final_xy_m : null,
    gripper_stalled_at: manifest.gripper_stalled_at,
    object_seen_in_jaws: cc.object_seen_in_jaws,
    object_left_original_spot: cc.object_left_original_spot,
    sam_pick: proofValue(manifest.sam, [
      before.id,
      liftWorkspace?.id,
      liftWrist?.id,
    ]),
    vlm_pick: proofValue(manifest.vlm, [before.id, after.id]),
    claimed_success: manifest.claimed_success,
    failure_hint: manifest.failure_hint,
  };
  return {
    kind: manifest.kind,
    judgement: judgeTrial(evidence),
    evidence,
    cc,
    config_sha256: digest(configText),
    commissioned: config.commissioned,
    external_checks: { sam: manifest.sam, vlm: manifest.vlm },
    note: "Offline replay of supplied evidence. Does not establish commissioning, smoke completion, or live trial admission. External checks are supplied records, not provider calls made by this command.",
  };
};

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new Error("Usage: bun run bench:judge <replay-manifest.json>");
    console.log(JSON.stringify(await replayTrial(path), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Replay failed");
    process.exitCode = 1;
  }
}
