/**
 * Month Outlook Card Component
 * Displays macro analysis comparing current month to historical patterns
 */
import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Calendar, Target, BarChart3 } from 'lucide-react';
import { api } from '../api';

type MonthOutlookData = Awaited<ReturnType<typeof api.getMonthOutlook>>;

export function MonthOutlookCard() {
  const [outlook, setOutlook] = useState<MonthOutlookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchOutlook = async () => {
      try {
        const data = await api.getMonthOutlook();
        setOutlook(data);
      } catch (err) {
        setError('Unable to load month outlook');
      } finally {
        setLoading(false);
      }
    };

    fetchOutlook();
    // Refresh every 6 hours
    const interval = setInterval(fetchOutlook, 6 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-[#1a1f2e] rounded-xl p-4 border border-gray-800 animate-pulse">
        <div className="h-6 bg-gray-700 rounded w-1/3 mb-4"></div>
        <div className="h-20 bg-gray-700 rounded"></div>
      </div>
    );
  }

  if (error || !outlook) {
    return null; // Don't show anything if no data
  }

  const { currentMonth, prediction, similarMonths, historicalBest, historicalWorst } = outlook;

  // Validate required data exists
  if (!prediction || !currentMonth || !similarMonths || !historicalBest || !historicalWorst) {
    return null;
  }

  const outlookConfig = {
    BULLISH: {
      icon: TrendingUp,
      color: 'text-green-400',
      bgColor: 'bg-green-500/10',
      borderColor: 'border-green-500/30',
      label: 'Bullish',
    },
    BEARISH: {
      icon: TrendingDown,
      color: 'text-red-400',
      bgColor: 'bg-red-500/10',
      borderColor: 'border-red-500/30',
      label: 'Bearish',
    },
    NEUTRAL: {
      icon: Minus,
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500/10',
      borderColor: 'border-yellow-500/30',
      label: 'Neutral',
    },
  };

  const config = outlookConfig[prediction.outlook];
  const OutlookIcon = config.icon;

  return (
    <div className={`bg-[#1a1f2e] rounded-xl p-4 border ${config.borderColor}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-300">
            {currentMonth.monthName} Outlook
          </span>
          <span className="text-xs text-gray-500">(Day {outlook.dayOfMonth})</span>
        </div>
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${config.bgColor}`}>
          <OutlookIcon className={`w-3.5 h-3.5 ${config.color}`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {config.label}
          </span>
          <span className="text-xs text-gray-500">
            {prediction.confidence.toFixed(0)}%
          </span>
        </div>
      </div>

      {/* Current Month Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="text-center">
          <div className="text-lg font-bold text-white">{currentMonth.trades}</div>
          <div className="text-xs text-gray-500">Trades</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-white">{currentMonth.winRate.toFixed(0)}%</div>
          <div className="text-xs text-gray-500">Win Rate</div>
        </div>
        <div className="text-center">
          <div className={`text-lg font-bold ${currentMonth.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${currentMonth.totalPnl.toFixed(0)}
          </div>
          <div className="text-xs text-gray-500">PnL</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold text-white">{(currentMonth.slRatio * 100).toFixed(0)}%</div>
          <div className="text-xs text-gray-500">SL Rate</div>
        </div>
      </div>

      {/* Similar Months */}
      <div className="mb-4">
        <div className="text-xs text-gray-500 mb-2 flex items-center gap-1">
          <BarChart3 className="w-3 h-3" />
          Similar historical months:
        </div>
        <div className="flex flex-wrap gap-1.5">
          {similarMonths.slice(0, 3).map((sim, idx) => {
            const outcomeColor = sim.finalOutcome === 'POSITIVE' 
              ? 'bg-green-500/20 text-green-400 border-green-500/30'
              : sim.finalOutcome === 'NEGATIVE'
              ? 'bg-red-500/20 text-red-400 border-red-500/30'
              : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
            
            return (
              <div
                key={idx}
                className={`px-2 py-1 rounded border text-xs ${outcomeColor}`}
                title={`${sim.month.monthName} ${sim.month.yearMonth.split('-')[0]}: ${sim.similarity.toFixed(0)}% similar, ended $${sim.month.totalPnl.toFixed(0)}`}
              >
                {sim.month.monthName} '{sim.month.yearMonth.slice(2, 4)}
                <span className="opacity-60 ml-1">{sim.similarity.toFixed(0)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Prediction Reasoning */}
      <div className="text-xs text-gray-400 mb-3 italic">
        "{prediction.reasoning}"
      </div>

      {/* Expected Outcome */}
      <div className="flex items-center justify-between pt-3 border-t border-gray-700/50">
        <div className="flex items-center gap-1">
          <Target className="w-3 h-3 text-gray-500" />
          <span className="text-xs text-gray-500">Expected:</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs">
            <span className="text-gray-500">WR:</span>{' '}
            <span className="text-white">{prediction.expectedWinRate.toFixed(0)}%</span>
          </span>
          <span className="text-xs">
            <span className="text-gray-500">PnL:</span>{' '}
            <span className={prediction.expectedPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
              ${prediction.expectedPnl.toFixed(0)}
            </span>
          </span>
        </div>
      </div>

      {/* Historical Context - mini */}
      <div className="flex items-center justify-between mt-2 text-xs text-gray-600">
        <span>Best: {historicalBest.monthName} '{historicalBest.yearMonth.slice(2,4)} (+${historicalBest.totalPnl.toFixed(0)})</span>
        <span>Worst: {historicalWorst.monthName} '{historicalWorst.yearMonth.slice(2,4)} (${historicalWorst.totalPnl.toFixed(0)})</span>
      </div>
    </div>
  );
}
