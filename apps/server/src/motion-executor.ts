import { actionLedger } from "./action-ledger";
import { createMotionExecutor } from "./motion-actions";
import * as robot from "./robot";

// The single admission point for supervised motion. Chat and decision runs
// share it, so its busy guard also keeps them from moving concurrently.
export const motionExecutor = createMotionExecutor(
  robot.motionIO,
  actionLedger
);
