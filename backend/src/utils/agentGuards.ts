import { getConfig } from './env.js';

export function areAgentGuardsDisabled(): boolean {
  try {
    return getConfig().DISABLE_AGENT_GUARDS === true;
  } catch {
    return false;
  }
}

