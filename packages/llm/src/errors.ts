export type LlmErrorCode =
  | "LLM_VALIDATION_FAILED"
  | "LLM_CALL_FAILED"
  | "LLM_TIMEOUT"
  | "LLM_LOAD_FAILED"
  | "LLM_FAKE_IN_DEMO";

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

/** Thrown after the last attempt produced output that does not match the schema. */
export class LlmValidationError extends LlmError {
  readonly attempts: number;
  readonly lastOutput: string;
  readonly detail: string;
  constructor(attempts: number, detail: string, lastOutput: string) {
    super(
      "LLM_VALIDATION_FAILED",
      `The local model did not produce a valid answer after ${attempts} attempt(s).`,
    );
    this.name = "LlmValidationError";
    this.attempts = attempts;
    this.detail = detail;
    this.lastOutput = lastOutput;
  }
}

/** The call took longer than `timeoutMs` or was aborted by the caller. */
export class LlmTimeoutError extends LlmError {
  constructor(readonly timeoutMs: number | null) {
    super("LLM_TIMEOUT", "The local model took too long to answer. Please try again.");
    this.name = "LlmTimeoutError";
  }
}
