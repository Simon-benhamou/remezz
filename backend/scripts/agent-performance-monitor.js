#!/usr/bin/env tsx
/**
 * Automated Agent Performance Monitor
 * Runs the performance analyzer at regular intervals and logs results
 * Can be used as a cron job or background service
 */
import { AgentPerformanceAnalyzer } from './agent-performance-analyzer.js';
import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
class AgentPerformanceMonitor {
    analyzer = new AgentPerformanceAnalyzer();
    config;
    logStream;
    isRunning = false;
    constructor(config = {}) {
        this.config = {
            intervalMinutes: 60, // Run every hour by default
            logFile: join(process.cwd(), 'logs', 'performance-monitor.log'),
            enableAlerts: true,
            alertThresholds: {
                criticalGradeCount: 2, // Alert if 2+ agents have F grade
                lowWinRateThreshold: 30, // Alert if global win rate below 30%
                negativeExpectancyCount: 3 // Alert if 3+ agents have negative expectancy
            },
            ...config
        };
        // Ensure logs directory exists
        const logsDir = join(process.cwd(), 'logs');
        mkdirSync(logsDir, { recursive: true });
        this.logStream = createWriteStream(this.config.logFile, { flags: 'a' });
    }
    async start() {
        if (this.isRunning) {
            console.log('Monitor is already running');
            return;
        }
        this.isRunning = true;
        console.log(`🚀 Starting automated performance monitor (every ${this.config.intervalMinutes} minutes)`);
        this.log('INFO', `Monitor started - interval: ${this.config.intervalMinutes} minutes`);
        // Run initial analysis
        await this.runAnalysis();
        // Schedule periodic analysis
        const intervalMs = this.config.intervalMinutes * 60 * 1000;
        setInterval(async () => {
            await this.runAnalysis();
        }, intervalMs);
    }
    stop() {
        this.isRunning = false;
        this.logStream.end();
        console.log('🛑 Performance monitor stopped');
        this.log('INFO', 'Monitor stopped');
    }
    async runAnalysis() {
        try {
            const timestamp = new Date().toISOString();
            console.log(`\n🔍 Running scheduled analysis at ${timestamp}`);
            const analysis = await this.analyzer.analyzeAllAgents();
            // Check alert conditions
            if (this.config.enableAlerts) {
                await this.checkAlerts(analysis);
            }
            // Log summary
            this.log('ANALYSIS', JSON.stringify({
                timestamp,
                globalWinRate: analysis.globalMetrics.globalWinRate,
                globalProfitFactor: analysis.globalMetrics.globalProfitFactor,
                activeAgents: analysis.globalMetrics.activeAgents,
                criticalAlerts: analysis.alerts.critical.length,
                warningAlerts: analysis.alerts.warnings.length,
                opportunities: analysis.alerts.opportunities.length
            }));
            console.log(`✅ Analysis complete - ${analysis.alerts.critical.length} critical, ${analysis.alerts.warnings.length} warnings`);
        }
        catch (error) {
            console.error('❌ Analysis failed:', error);
            this.log('ERROR', `Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async checkAlerts(analysis) {
        const alerts = [];
        // Check critical grade count
        const criticalCount = analysis.agentDetails.filter((a) => a.grade === 'F').length;
        if (criticalCount >= this.config.alertThresholds.criticalGradeCount) {
            alerts.push(`CRITICAL: ${criticalCount} agents with F grade performance`);
        }
        // Check global win rate
        if (analysis.globalMetrics.globalWinRate < this.config.alertThresholds.lowWinRateThreshold) {
            alerts.push(`WARNING: Global win rate below ${this.config.alertThresholds.lowWinRateThreshold}% (${analysis.globalMetrics.globalWinRate.toFixed(1)}%)`);
        }
        // Check negative expectancy count
        const negativeExpectancyCount = analysis.agentDetails.filter((a) => a.expectancy < 0).length;
        if (negativeExpectancyCount >= this.config.alertThresholds.negativeExpectancyCount) {
            alerts.push(`WARNING: ${negativeExpectancyCount} agents with negative expectancy`);
        }
        // Send alerts if any
        for (const alert of alerts) {
            console.log(`🚨 ${alert}`);
            this.log('ALERT', alert);
            // Here you could integrate with notification services (email, Slack, etc.)
        }
    }
    log(level, message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${level}: ${message}\n`;
        this.logStream.write(logEntry);
    }
}
// Main execution
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const monitor = new AgentPerformanceMonitor({
        intervalMinutes: parseInt(process.env.MONITOR_INTERVAL_MINUTES || '60'),
        enableAlerts: process.env.DISABLE_ALERTS !== 'true'
    });
    switch (command) {
        case 'start':
            await monitor.start();
            // Keep the process running
            process.on('SIGINT', () => {
                monitor.stop();
                process.exit(0);
            });
            break;
        case 'once':
            console.log('🔍 Running one-time analysis...');
            const analyzer = new AgentPerformanceAnalyzer();
            await analyzer.analyzeAllAgents();
            break;
        case 'stop':
            monitor.stop();
            break;
        default:
            console.log(`
Automated Agent Performance Monitor

Usage:
  npm run monitor:start    # Start continuous monitoring
  npm run monitor:once     # Run single analysis
  npm run monitor:stop     # Stop monitoring

Environment variables:
  MONITOR_INTERVAL_MINUTES  # Analysis interval in minutes (default: 60)
  DISABLE_ALERTS           # Set to 'true' to disable alerts (default: false)

Examples:
  MONITOR_INTERVAL_MINUTES=30 npm run monitor:start  # Run every 30 minutes
  npm run monitor:once                               # Single analysis run
      `);
            process.exit(1);
    }
}
// Run if called directly
if (process.argv[1]?.endsWith('agent-performance-monitor.ts')) {
    main();
}
export { AgentPerformanceMonitor };
