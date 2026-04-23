export class AskError extends Error {
  readonly exitCode: number;
  readonly attempted: string;
  readonly nextStep: string;

  constructor(message: string, exitCode: number, attempted: string, nextStep: string) {
    super(message);
    this.name = "AskError";
    this.exitCode = exitCode;
    this.attempted = attempted;
    this.nextStep = nextStep;
  }
}
