import { Effect, Schema } from "effect";
import { InvalidInput, InvalidOutput } from "./errors.js";
import type { KernelOperation } from "./kernel-operation.js";

/** Shared contract validation for hosted and caller-owned operation runners. */
export const decodeKernelOperationInput = <Input, EncodedInput, Output, EncodedOutput>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  rawInput: unknown,
) =>
  Schema.decodeUnknown(operation.input)(rawInput).pipe(
    Effect.mapError(() => new InvalidInput({ operation: operation.name })),
  );

export const validateKernelOperationOutput = <Input, EncodedInput, Output, EncodedOutput>(
  operation: KernelOperation<Input, EncodedInput, Output, EncodedOutput>,
  output: unknown,
) =>
  Schema.validate(operation.output)(output).pipe(
    Effect.mapError((cause) => new InvalidOutput({ operation: operation.name, cause, output })),
  );
