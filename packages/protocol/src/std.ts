/** Effect supplies validation and JSON Schema from one definition. The bridge
 * joins the two Standard Schema interfaces and rejects excess properties.
 * Synchronous chat schemas also retain defaults without coercing input. */

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
  const validator = Schema.toStandardSchemaV1(schema, {
    parseOptions: { onExcessProperty: "error" },
  });
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
