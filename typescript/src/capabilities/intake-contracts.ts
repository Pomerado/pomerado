import { Schema } from "effect";

export const IntakeReasonCode = Schema.Literal(
  "stateful_flow",
  "branching_form",
  "realtime_stream",
  "file_download",
  "native_app_only",
  "long_running",
  "multi_account",
);
export type IntakeReasonCode = typeof IntakeReasonCode.Type;
