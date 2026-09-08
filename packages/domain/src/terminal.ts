import { Schema } from "effect";

const Cols = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 240 }));
const Rows = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 100 }));
export const TerminalSize = Schema.Struct({ cols: Cols, rows: Rows });
export const TerminalSession = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["starting", "running", "exited"]),
  cols: Cols,
  rows: Rows,
  exit_code: Schema.NullOr(Schema.Int),
  expires_at: Schema.Finite,
});
export type TerminalSession = typeof TerminalSession.Type;
export const TerminalClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("input"),
    data: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  Schema.Struct({ type: Schema.Literal("resize"), cols: Cols, rows: Rows }),
]);
export type TerminalClientMessage = typeof TerminalClientMessage.Type;
export const TerminalServerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    session: TerminalSession,
    replay: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("output"), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Int),
    reason: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
export type TerminalServerMessage = typeof TerminalServerMessage.Type;
