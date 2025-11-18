import { agentServiceRegistry } from './subagents/serviceRegistry.js';

export type AgentOrchestratorContext = {
  services: typeof agentServiceRegistry;
};

const context: AgentOrchestratorContext = {
  services: agentServiceRegistry,
};

export function getAgentContext(): AgentOrchestratorContext {
  return context;
}
