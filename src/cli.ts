#!/usr/bin/env bun
import { callTool } from "./client";

const [name, input = "{}"] = process.argv.slice(2);
if (!name || name === "--help") {
  console.log(
    "robo <observe|capture|acquire|renew|release|move|operation|stop|perceive|recording_start|recording_stop|shell> '[JSON]'\nSet ROBO_URL, ROBO_TOKEN, and optionally ROBO_CONTROLLER. Units: joint degrees, gripper percent, Cartesian meters. Control expires after three seconds without renewal."
  );
} else {
  try {
    console.log(
      JSON.stringify(await callTool(name, JSON.parse(input)), null, 2)
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Command failed");
    process.exitCode = 1;
  }
}
