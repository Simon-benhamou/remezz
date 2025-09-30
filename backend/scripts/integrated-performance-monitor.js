#!/usr/bin/env tsx
/**
 * Integrated Performance Monitor Service
 * Automatically starts when agents are active and stops when no agents remain
 * Integrated with the agent lifecycle
 */
import { AgentPerformanceMonitor } from './agent-performance-monitor.js';
import { prisma } from '../src/db/client.js';
class IntegratedPerformanceMonitor {
    monitor = null;
    isMonitoring = false;
    checkInterval = null;
    CHECK_INTERVAL_MS = 30000; // Check every 30 seconds
    constructor() {
        this.startLifecycleMonitoring();
    }
    async startLifecycleMonitoring() {
        console.log('🔄 Starting integrated performance monitoring lifecycle...');
        // Check immediately
        await this.checkAgentLifecycle();
        // Set up periodic checking
        this.checkInterval = setInterval(async () => {
            await this.checkAgentLifecycle();
        }, this.CHECK_INTERVAL_MS);
    }
    async checkAgentLifecycle() {
        try {
            // Count active agents
            const activeAgentCount = await prisma.agentSession.count({
                where: { stoppedAt: null }
            });
            if (activeAgentCount > 0 && !this.isMonitoring) {
                // Agents are active, start monitoring
                console.log(`🤖 ${activeAgentCount} agent(s) active - starting performance monitoring...`);
                await this.startMonitoring();
            }
            else if (activeAgentCount === 0 && this.isMonitoring) {
                // No agents active, stop monitoring
                console.log('💤 No active agents - stopping performance monitoring...');
                await this.stopMonitoring();
            }
            else if (activeAgentCount > 0 && this.isMonitoring) {
                // Agents still active, monitoring continues
                // Could log occasional status updates here if needed
            }
        }
        catch (error) {
            console.error('❌ Error in lifecycle monitoring:', error);
        }
    }
    async startMonitoring() {
        if (this.isMonitoring)
            return;
        try {
            this.monitor = new AgentPerformanceMonitor({
                intervalMinutes: 60, // Run every hour
                enableAlerts: true
            });
            await this.monitor.start();
            this.isMonitoring = true;
            console.log('✅ Performance monitoring started automatically');
        }
        catch (error) {
            console.error('❌ Failed to start performance monitoring:', error);
        }
    }
    async stopMonitoring() {
        if (!this.isMonitoring || !this.monitor)
            return;
        try {
            this.monitor.stop();
            this.monitor = null;
            this.isMonitoring = false;
            console.log('🛑 Performance monitoring stopped automatically');
        }
        catch (error) {
            console.error('❌ Error stopping performance monitoring:', error);
        }
    }
    async forceStartMonitoring() {
        console.log('🔧 Force starting performance monitoring...');
        await this.startMonitoring();
    }
    async forceStopMonitoring() {
        console.log('🔧 Force stopping performance monitoring...');
        await this.stopMonitoring();
    }
    getStatus() {
        return {
            isMonitoring: this.isMonitoring,
            activeAgents: 0 // Will be updated by checkAgentLifecycle
        };
    }
    cleanup() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.monitor) {
            this.monitor.stop();
        }
        console.log('🧹 Integrated performance monitor cleaned up');
    }
}
// Global instance
let globalMonitor = null;
export function getIntegratedMonitor() {
    if (!globalMonitor) {
        globalMonitor = new IntegratedPerformanceMonitor();
    }
    return globalMonitor;
}
export function startIntegratedMonitoring() {
    getIntegratedMonitor();
}
export function stopIntegratedMonitoring() {
    if (globalMonitor) {
        globalMonitor.cleanup();
        globalMonitor = null;
    }
}
// Graceful shutdown
process.on('SIGINT', () => {
    console.log('📴 Shutting down integrated performance monitor...');
    stopIntegratedMonitoring();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('📴 Shutting down integrated performance monitor...');
    stopIntegratedMonitoring();
    process.exit(0);
});
// Auto-start if this file is run directly
if (process.argv[1]?.endsWith('integrated-performance-monitor.ts')) {
    console.log('🚀 Starting integrated performance monitor service...');
    startIntegratedMonitoring();
    // Keep the process alive
    setInterval(() => {
        // Periodic heartbeat
    }, 60000); // Every minute
}
