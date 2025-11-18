import { AgentActionExecutorLoop } from './actionLoop.js';

let loop: AgentActionExecutorLoop | null = null;

export function startAgentActionLoop(): void {
  if (loop) return;
  loop = new AgentActionExecutorLoop();
  loop.start();
}

export function stopAgentActionLoop(): void {
  loop?.stop();
  loop = null;
}
