import { Predicate, Schema } from "effect";

export const FailureCode = Schema.Literals([
  "INVALID_INPUT",
  "CONTROL_REVOKED",
  "CONTROL_BUSY",
  "MOTION_BUSY",
  "UNSAFE_TARGET",
  "CAPABILITY_UNAVAILABLE",
  "OUTCOME_UNKNOWN",
  "MOTION_FAILED",
  "CANCELLED",
  "TOOL_FAILED",
  "TOOL_NOT_AVAILABLE",
  "REPEATED_FAILURE",
  "OPERATOR_STEERED",
]);
export type FailureCode = typeof FailureCode.Type;

export class ToolFailure extends Schema.TaggedError<ToolFailure>()(
  "ToolFailure",
  {
    code: FailureCode,
    detail: Schema.String,
  }
) {
  override get message() {
    return `${this.code}: ${this.detail}`;
  }
}

const redact = (text: string): string =>
  text
    .replaceAll(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replaceAll(/\b(?:sk|sk-ant)-[a-z\d_-]+/giu, "[redacted]")
    .replaceAll(
      /(?<prefix>(?:api[_-]?key|token|authorization|password|secret|lease_id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      "$<prefix>[redacted]"
    )
    .slice(0, 500);

export interface ToolErrorDescription {
  code: FailureCode;
  message: string;
  path?: string;
}
export const describeToolError = (error: unknown): ToolErrorDescription => {
  const raw = Predicate.isString(error)
    ? error
    : error instanceof Error && Predicate.isString(error.message)
      ? error.message
      : "Tool execution failed";
  if (
    /Input validation failed|Failed to parse tool arguments|Invalid input for tool|Type validation failed|SchemaError\(/u.test(
      raw
    )
  ) {
    const path = /at (?<path>\["[^"\n]{1,60}"\])/u.exec(raw)?.groups?.["path"];
    const expected = /Expected (?<expected>number|boolean|string)/u.exec(raw)
      ?.groups?.["expected"];
    return {
      code: "INVALID_INPUT",
      message: `Invalid tool arguments${path ? ` at ${path}` : ""}.${expected ? ` Expected a JSON ${expected}.` : " Follow the tool schema."} Numbers and booleans must not be quoted.`,
      ...(path ? { path } : {}),
    };
  }
  if (/unavailable tool|not available|No such tool|Unknown tool/iu.test(raw)) {
    return { code: "TOOL_NOT_AVAILABLE", message: redact(raw) };
  }
  const code = Schema.decodeUnknownOption(FailureCode)(raw.split(":", 1)[0]);
  if (code._tag === "Some") {
    return { code: code.value, message: redact(raw) };
  }
  if (/lease|controller|revoked|take.?over/iu.test(raw)) {
    return { code: "CONTROL_REVOKED", message: redact(raw) };
  }
  return { code: "TOOL_FAILED", message: redact(raw) };
};
