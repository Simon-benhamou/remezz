import { AgentDecisionLoop } from './decisionLoop.js';

let decisionLoop: AgentDecisionLoop | null = null;

export function startAgentDecisionLoop(): void {
  if (!decisionLoop) {
    decisionLoop = new AgentDecisionLoop();
    decisionLoop.start();
  }
}

export function stopAgentDecisionLoop(): void {
  decisionLoop?.stop();
  decisionLoop = null;
}
