import { createLogger } from '../../utils/logger.js';

export abstract class AgentLoop {
  protected readonly logger = createLogger(this.constructor.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly intervalMs: number, private readonly runOnStart = true) {}

  start(): void {
    if (this.timer) return;
    if (this.runOnStart) {
      this.safeTick();
    }
    this.timer = setInterval(() => this.safeTick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.logger.error('Loop tick failed', { error });
    }
  }

  protected abstract tick(): Promise<void>;
}
