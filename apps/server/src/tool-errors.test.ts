import { expect, test } from "bun:test";

import { describeToolError, ToolFailure } from "./tool-errors";

test("SDK string validation errors expose the path and expected type without raw arguments", () => {
  const result = describeToolError(
    'Invalid input for tool move: Type validation failed: Value: {"token":"sensitive"}. Error message: SchemaError(Expected number | undefined at ["duration_s"])'
  );
  expect(result.code).toBe("INVALID_INPUT");
  expect(result.path).toBe('["duration_s"]');
  expect(result.message).toContain("JSON number");
  expect(result.message).not.toContain("sensitive");
});

test("execution failures preserve codes and redact credentials", () => {
  const failure = new ToolFailure({
    code: "OUTCOME_UNKNOWN",
    detail: "Operation status unavailable",
  });
  expect(describeToolError(failure).code).toBe("OUTCOME_UNKNOWN");
  expect(
    describeToolError(
      'request failed: token="private-value" Bearer credential-value'
    ).message
  ).not.toContain("private-value");
  expect(
    describeToolError(
      'request failed: token="private-value" Bearer credential-value'
    ).message
  ).not.toContain("credential-value");
});
