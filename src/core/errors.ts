export class TwinError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(code: string, message: string, hint?: string, exitCode = 1) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}
