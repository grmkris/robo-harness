/**
 * Effect Schema → the AI SDK's tool schema.
 *
 * The SDK accepts any Standard Schema whose `~standard` carries both a
 * `validate` (to check the model's arguments) and a `jsonSchema` (to tell the
 * model what to send). Effect produces those from two different calls —
 * `toStandardSchemaV1` and `toStandardJSONSchemaV1` — and each result's
 * `~standard` is missing the other's half. Merging them is the whole job, and
 * it is what keeps Zod out of the repository: `AGENTS.md` reserves schema
 * duties for Effect, and a second schema library would mean two definitions of
 * every tool's arguments, free to drift apart at exactly the boundary an
 * attacker would most like them to.
 *
 * The return type is stated as the SDK's own `StandardSchema<T>` rather than
 * inferred. Effect's schema type carries a dozen internal phantom fields that
 * the SDK's `FlexibleSchema` union cannot match structurally, and this is the
 * one place that mismatch is worth naming instead of propagating.
 */

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from "@standard-schema/spec";
import { Schema } from "effect";

type ToolSchema<T> = StandardSchemaV1<unknown, T> & {
  readonly "~standard": StandardSchemaV1.Props<unknown, T> & {
    readonly jsonSchema: StandardJSONSchemaV1.Converter;
  };
};

export const std = <S extends Schema.Codec<unknown>>(
  schema: S
): ToolSchema<S["Type"]> => {
  const validator = Schema.toStandardSchemaV1(schema);
  const json = Schema.toStandardJSONSchemaV1(schema);
  const merged = {
    ...validator,
    "~standard": {
      ...validator["~standard"],
      jsonSchema: json["~standard"].jsonSchema,
    },
  };
  // Both halves of the Standard Schema contract are present: `validate` from
  // the codec and `jsonSchema` from the JSON converter, produced by Effect from
  // the *same* schema, so they cannot describe different shapes.
  return merged;
};
