#!/usr/bin/env tsx
/**
 * Agent Performance Analyzer
 * Automatically evaluates trading agents and generates real-time analysis reports
 * Identifies issues and suggests improvements
 */
import { prisma } from '../src/db/client.js';
import { getConfig } from '../src/utils/env.js';
class AgentPerformanceAnalyzer {
    config = getConfig();
    async analyzeAllAgents() {
        console.log('🔍 Starting comprehensive agent performance analysis...\n');
        // Get all active sessions with their KPIs
        const activeSessions = await prisma.agentSession.findMany({
            where: { stoppedAt: null },
            include: {
                kpi: true,
                positions: { where: { qty: { gt: 0 } } },
                fills: { take: 100, orderBy: { ts: 'desc' } }
            }
        });
        console.log(`📊 Analyzing ${activeSessions.length} active agents...\n`);
        const agentMetrics = [];
        for (const session of activeSessions) {
            const metrics = await this.analyzeAgent(session);
            agentMetrics.push(metrics);
        }
        const analysis = await this.generateAnalysis(agentMetrics);
        await this.logAnalysis(analysis);
        await this.generateAlerts(analysis);
        return analysis;
    }
    async analyzeAgent(session) {
        const kpi = session.kpi;
        const stats = kpi?.stats || {};
        // Calculate advanced metrics
        const trades = stats.trades || 0;
        const wins = stats.wins || 0;
        const losses = stats.losses || 0;
        const winRate = trades > 0 ? (wins / trades) * 100 : 0;
        // Get recent fills for detailed analysis
        const recentFills = await prisma.fill.findMany({
            where: { sessionId: session.id },
            orderBy: { ts: 'desc' },
            take: 50
        });
        // Calculate profit/loss metrics
        const profitableTrades = recentFills.filter(f => (f.realizedPnl || 0) > 0);
        const losingTrades = recentFills.filter(f => (f.realizedPnl || 0) < 0);
        const totalPnL = recentFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
        const avgWin = profitableTrades.length > 0 ?
            profitableTrades.reduce((sum, f) => sum + (f.realizedPnl || 0), 0) / profitableTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ?
            Math.abs(losingTrades.reduce((sum, f) => sum + (f.realizedPnl || 0), 0) / losingTrades.length) : 0;
        const profitFactor = avgLoss > 0 ? (avgWin * profitableTrades.length) / (avgLoss * losingTrades.length) : 0;
        // Calculate streaks and patterns
        const { currentStreak, maxConsecutiveWins, maxConsecutiveLosses } = this.calculateStreaks(recentFills);
        // Risk metrics
        const expectancy = winRate > 0 ? (winRate / 100 * avgWin) - ((100 - winRate) / 100 * avgLoss) : 0;
        const riskRewardRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
        // Calculate holding times
        const avgHoldingTime = this.calculateAverageHoldingTime(recentFills);
        // Generate issues and recommendations
        const { issues, recommendations, score, grade } = this.evaluateAgent({
            trades, winRate, profitFactor, expectancy, currentStreak,
            maxConsecutiveLosses, avgHoldingTime, riskRewardRatio
        });
        return {
            sessionId: session.id,
            symbol: session.symbol,
            mode: session.mode,
            trades,
            wins,
            losses,
            winRate,
            profitFactor,
            totalPnL,
            avgWin,
            avgLoss,
            maxDrawdown: kpi?.maxDrawdownPct || 0,
            expectancy,
            sharpeRatio: this.calculateSharpeRatio(recentFills),
            calmarRatio: this.calculateCalmarRatio(totalPnL, kpi?.maxDrawdownPct || 0),
            currentStreak,
            maxConsecutiveWins,
            maxConsecutiveLosses,
            avgHoldingTime,
            riskRewardRatio,
            score,
            grade,
            issues,
            recommendations
        };
    }
    calculateStreaks(fills) {
        if (fills.length === 0)
            return { currentStreak: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0 };
        let currentStreak = 0;
        let maxConsecutiveWins = 0;
        let maxConsecutiveLosses = 0;
        let currentWinStreak = 0;
        let currentLossStreak = 0;
        // Sort by creation time (oldest first)
        const sortedFills = fills.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        for (const fill of sortedFills) {
            const pnl = fill.realizedPnl || 0;
            if (pnl > 0) {
                currentWinStreak++;
                currentLossStreak = 0;
                maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWinStreak);
                currentStreak = currentWinStreak;
            }
            else if (pnl < 0) {
                currentLossStreak++;
                currentWinStreak = 0;
                maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLossStreak);
                currentStreak = -currentLossStreak;
            }
        }
        return { currentStreak, maxConsecutiveWins, maxConsecutiveLosses };
    }
    calculateAverageHoldingTime(fills) {
        const entryExitPairs = [];
        const entries = [];
        // Group fills by order pairs (entry/exit)
        for (const fill of fills.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())) {
            if (fill.side === 'buy') {
                entries.push(fill);
            }
            else if (fill.side === 'sell' && entries.length > 0) {
                const entry = entries.pop();
                if (entry) {
                    entryExitPairs.push({ entry, exit: fill });
                }
            }
        }
        if (entryExitPairs.length === 0)
            return 0;
        const totalHoldingTime = entryExitPairs.reduce((sum, pair) => {
            const entryTime = new Date(pair.entry.ts).getTime();
            const exitTime = new Date(pair.exit.ts).getTime();
            return sum + (exitTime - entryTime);
        }, 0);
        return totalHoldingTime / entryExitPairs.length / (1000 * 60); // Convert to minutes
    }
    calculateSharpeRatio(fills) {
        if (fills.length < 2)
            return 0;
        const returns = fills.map(f => f.realizedPnl || 0);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        return stdDev > 0 ? avgReturn / stdDev : 0;
    }
    calculateCalmarRatio(totalPnL, maxDrawdown) {
        return maxDrawdown > 0 ? totalPnL / maxDrawdown : 0;
    }
    evaluateAgent(metrics) {
        const issues = [];
        const recommendations = [];
        let score = 0;
        // Win Rate Analysis
        if (metrics.winRate < 40) {
            issues.push(`Win rate trop faible: ${metrics.winRate.toFixed(1)}%`);
            recommendations.push('Réviser la stratégie d\'entrée - trop de faux signaux');
            score -= 20;
        }
        else if (metrics.winRate > 70) {
            issues.push(`Win rate exceptionnellement élevé: ${metrics.winRate.toFixed(1)}% - possible overfitting`);
            recommendations.push('Vérifier si la stratégie n\'est pas trop optimisée pour les conditions actuelles');
            score -= 10;
        }
        else if (metrics.winRate >= 50) {
            score += 15;
        }
        // Profit Factor Analysis
        if (metrics.profitFactor < 1.1) {
            issues.push(`Profit factor insuffisant: ${metrics.profitFactor.toFixed(2)}`);
            recommendations.push('Améliorer le risk/reward ratio - pertes trop importantes');
            score -= 25;
        }
        else if (metrics.profitFactor > 1.5) {
            score += 20;
        }
        // Expectancy Analysis
        if (metrics.expectancy < 0) {
            issues.push(`Expectancy négatif: ${metrics.expectancy.toFixed(2)}`);
            recommendations.push('Stratégie globalement perdante - révision complète nécessaire');
            score -= 30;
        }
        else if (metrics.expectancy > 0.5) {
            score += 15;
        }
        // Streak Analysis
        if (Math.abs(metrics.currentStreak) > 5) {
            const streakType = metrics.currentStreak > 0 ? 'gains' : 'pertes';
            issues.push(`Série de ${Math.abs(metrics.currentStreak)} ${streakType} consécutifs`);
            recommendations.push('Surveiller la régression à la moyenne - ajuster la taille des positions');
        }
        if (metrics.maxConsecutiveLosses > 8) {
            issues.push(`Série maximale de pertes: ${metrics.maxConsecutiveLosses} trades`);
            recommendations.push('Implémenter un circuit breaker après 5-6 pertes consécutives');
            score -= 15;
        }
        // Holding Time Analysis
        if (metrics.avgHoldingTime < 30) { // Less than 30 minutes
            issues.push(`Positions trop courtes: ${metrics.avgHoldingTime.toFixed(0)} minutes`);
            recommendations.push('Laisser plus de temps aux trades pour se développer');
        }
        else if (metrics.avgHoldingTime > 24 * 60) { // More than 24 hours
            issues.push(`Positions trop longues: ${metrics.avgHoldingTime.toFixed(0)} minutes`);
            recommendations.push('Réduire le holding time - risque d\'événements défavorables');
        }
        // Risk/Reward Analysis
        if (metrics.riskRewardRatio < 1.5) {
            issues.push(`Risk/Reward défavorable: 1:${metrics.riskRewardRatio.toFixed(1)}`);
            recommendations.push('Ajuster les stops et targets pour un meilleur ratio');
            score -= 10;
        }
        // Sample Size Analysis
        if (metrics.trades < 10) {
            issues.push(`Échantillon insuffisant: seulement ${metrics.trades} trades`);
            recommendations.push('Attendre plus de données avant de conclure');
            score -= 5;
        }
        // Calculate grade
        let grade;
        if (score >= 30)
            grade = 'A';
        else if (score >= 20)
            grade = 'B';
        else if (score >= 0)
            grade = 'C';
        else if (score >= -20)
            grade = 'D';
        else
            grade = 'F';
        return { issues, recommendations, score: Math.max(0, Math.min(100, score + 50)), grade };
    }
    async generateAnalysis(agentMetrics) {
        const totalAgents = agentMetrics.length;
        const activeAgents = agentMetrics.filter(a => a.trades > 0).length;
        const totalTrades = agentMetrics.reduce((sum, a) => sum + a.trades, 0);
        const totalWins = agentMetrics.reduce((sum, a) => sum + a.wins, 0);
        const globalWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
        const totalProfits = agentMetrics.reduce((sum, a) => sum + Math.max(0, a.totalPnL), 0);
        const totalLosses = agentMetrics.reduce((sum, a) => sum + Math.abs(Math.min(0, a.totalPnL)), 0);
        const globalProfitFactor = totalLosses > 0 ? totalProfits / totalLosses : 0;
        const bestPerformer = agentMetrics.reduce((best, current) => current.score > best.score ? current : best, agentMetrics[0]);
        const worstPerformer = agentMetrics.reduce((worst, current) => current.score < worst.score ? current : worst, agentMetrics[0]);
        return {
            timestamp: new Date().toISOString(),
            globalMetrics: {
                totalAgents,
                activeAgents,
                totalTrades,
                globalWinRate,
                globalProfitFactor,
                bestPerformer: bestPerformer.symbol,
                worstPerformer: worstPerformer.symbol
            },
            agentDetails: agentMetrics,
            marketConditions: await this.analyzeMarketConditions(agentMetrics),
            alerts: this.generateAlertsFromMetrics(agentMetrics)
        };
    }
    async analyzeMarketConditions(agentMetrics) {
        // Analyze overall market conditions based on agent performance
        const avgWinRate = agentMetrics.reduce((sum, a) => sum + a.winRate, 0) / agentMetrics.length;
        const avgProfitFactor = agentMetrics.reduce((sum, a) => sum + a.profitFactor, 0) / agentMetrics.length;
        let volatility;
        let trend;
        const recommendations = [];
        if (avgWinRate < 45) {
            volatility = 'HIGH';
            trend = 'BEARISH';
            recommendations.push('Marché difficile - réduire l\'agressivité des agents');
            recommendations.push('Augmenter les seuils de confirmation des signaux');
        }
        else if (avgWinRate > 60) {
            volatility = 'MODERATE';
            trend = 'BULLISH';
            recommendations.push('Marché favorable - maintenir la stratégie actuelle');
        }
        else {
            volatility = 'MODERATE';
            trend = 'SIDEWAYS';
            recommendations.push('Marché neutre - optimiser pour les ranges');
        }
        if (avgProfitFactor < 1.2) {
            recommendations.push('Profit factor global faible - réviser les stratégies de sortie');
        }
        return { volatility, trend, recommendations };
    }
    generateAlertsFromMetrics(agentMetrics) {
        const critical = [];
        const warnings = [];
        const opportunities = [];
        for (const agent of agentMetrics) {
            if (agent.grade === 'F') {
                critical.push(`${agent.symbol}: Performance critique (Grade F) - arrêt recommandé`);
            }
            else if (agent.grade === 'D') {
                warnings.push(`${agent.symbol}: Performance faible (Grade D) - surveillance accrue`);
            }
            if (agent.maxConsecutiveLosses > 10) {
                critical.push(`${agent.symbol}: ${agent.maxConsecutiveLosses} pertes consécutives - intervention immédiate`);
            }
            if (agent.expectancy < -0.5) {
                critical.push(`${agent.symbol}: Expectancy très négatif - révision stratégique urgente`);
            }
            if (agent.score > 80) {
                opportunities.push(`${agent.symbol}: Excellente performance (Score ${agent.score}) - modèle à répliquer`);
            }
            if (agent.profitFactor > 2.0) {
                opportunities.push(`${agent.symbol}: Profit factor exceptionnel (${agent.profitFactor.toFixed(2)})`);
            }
        }
        return { critical, warnings, opportunities };
    }
    async logAnalysis(analysis) {
        const logEntry = {
            timestamp: analysis.timestamp,
            summary: `Global Win Rate: ${analysis.globalMetrics.globalWinRate.toFixed(1)}%, ` +
                `Profit Factor: ${analysis.globalMetrics.globalProfitFactor.toFixed(2)}, ` +
                `Active Agents: ${analysis.globalMetrics.activeAgents}/${analysis.globalMetrics.totalAgents}`,
            alerts: analysis.alerts,
            recommendations: analysis.marketConditions.recommendations
        };
        console.log('\n📊 === PERFORMANCE ANALYSIS REPORT ===');
        console.log(`⏰ ${new Date().toLocaleString()}`);
        console.log(`📈 Global Win Rate: ${analysis.globalMetrics.globalWinRate.toFixed(1)}%`);
        console.log(`💰 Global Profit Factor: ${analysis.globalMetrics.globalProfitFactor.toFixed(2)}`);
        console.log(`🤖 Active Agents: ${analysis.globalMetrics.activeAgents}/${analysis.globalMetrics.totalAgents}`);
        console.log(`🏆 Best Performer: ${analysis.globalMetrics.bestPerformer}`);
        console.log(`⚠️  Worst Performer: ${analysis.globalMetrics.worstPerformer}`);
        console.log('\n🎯 AGENT DETAILS:');
        analysis.agentDetails.forEach(agent => {
            console.log(`\n${agent.symbol} (${agent.mode}):`);
            console.log(`  📊 Trades: ${agent.trades} | Win Rate: ${agent.winRate.toFixed(1)}% | Score: ${agent.score}/100 (${agent.grade})`);
            console.log(`  💰 P&L: ${agent.totalPnL.toFixed(2)} | Profit Factor: ${agent.profitFactor.toFixed(2)}`);
            console.log(`  🎲 Expectancy: ${agent.expectancy.toFixed(2)} | Risk/Reward: 1:${agent.riskRewardRatio.toFixed(1)}`);
            if (agent.issues.length > 0) {
                console.log(`  ⚠️  Issues: ${agent.issues.join(', ')}`);
            }
            if (agent.recommendations.length > 0) {
                console.log(`  💡 Recommendations: ${agent.recommendations.join(', ')}`);
            }
        });
        console.log('\n🌍 MARKET CONDITIONS:');
        console.log(`  📈 Trend: ${analysis.marketConditions.trend}`);
        console.log(`  🌊 Volatility: ${analysis.marketConditions.volatility}`);
        console.log(`  💡 Market Recommendations: ${analysis.marketConditions.recommendations.join(', ')}`);
        console.log('\n🚨 ALERTS:');
        if (analysis.alerts.critical.length > 0) {
            console.log('  🔴 CRITICAL:');
            analysis.alerts.critical.forEach(alert => console.log(`    • ${alert}`));
        }
        if (analysis.alerts.warnings.length > 0) {
            console.log('  🟡 WARNINGS:');
            analysis.alerts.warnings.forEach(alert => console.log(`    • ${alert}`));
        }
        if (analysis.alerts.opportunities.length > 0) {
            console.log('  🟢 OPPORTUNITIES:');
            analysis.alerts.opportunities.forEach(alert => console.log(`    • ${alert}`));
        }
        // Save to database for historical tracking
        await this.saveAnalysisToDatabase(analysis);
    }
    async saveAnalysisToDatabase(analysis) {
        try {
            // Note: This would require adding a new table to the schema
            // For now, we'll just log to console
            console.log('💾 Analysis saved to logs (database integration pending)');
        }
        catch (error) {
            console.error('Failed to save analysis to database:', error);
        }
    }
    async generateAlerts(analysis) {
        // Generate system alerts for critical issues
        for (const alert of analysis.alerts.critical) {
            console.log(`🚨 CRITICAL ALERT: ${alert}`);
            // Here you could integrate with notification systems (email, Slack, etc.)
        }
        for (const alert of analysis.alerts.warnings) {
            console.log(`⚠️  WARNING: ${alert}`);
        }
    }
}
// Main execution
async function main() {
    try {
        const analyzer = new AgentPerformanceAnalyzer();
        await analyzer.analyzeAllAgents();
        console.log('\n✅ Analysis complete!');
    }
    catch (error) {
        console.error('❌ Analysis failed:', error);
        process.exit(1);
    }
}
// Run if called directly
if (process.argv[1]?.endsWith('agent-performance-analyzer.ts')) {
    main();
}
export { AgentPerformanceAnalyzer };
