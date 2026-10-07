/** The LLM calls of one run are shared by everything that asks the model (link ranking, page analysis). */
export class LlmMeter {
  used = 0;
  constructor(readonly max: number) {}

  /** Reserves one call; false when the run's allowance is spent. */
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
}
