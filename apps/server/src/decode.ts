import { Schema } from "effect";

import { ApiError } from "./robot";

/** Decode an untrusted request body against a schema, strictly. */
export function decode<S extends Schema.Codec<any>>(
  schema: S,
  raw: unknown
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(raw);
  } catch {
    throw new ApiError("Invalid request", 400);
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export const isUuid = (value: string | undefined): boolean =>
  value !== undefined && uuidPattern.test(value);
export const Uuid = Schema.String.check(Schema.isPattern(uuidPattern));
