import { ReboundRejectionAgent, ActivationProfile } from './state.js';

export class AgentsHub {
  private agents = new Map<string, ReboundRejectionAgent>(); // sessionId -> agent

  get(sessionId: string) { return this.agents.get(sessionId) || null; }

  async activate(sessionId: string, profile: ActivationProfile) {
    let a = this.agents.get(sessionId);
    if (!a) { a = new ReboundRejectionAgent(); this.agents.set(sessionId, a); }
    (a as any).sessionId = sessionId;
    await a.activate(profile);
    return a;
  }

  async halt(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a) a.halt();
  }

  async closeNow(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a && (a as any).closeNow) await (a as any).closeNow();
  }

  async onTick(sessionId: string) {
    const a = this.agents.get(sessionId);
    if (a) await a.onTick();
  }

  listActiveIds() { return Array.from(this.agents.keys()); }
}

export const AgentHub = new AgentsHub();

