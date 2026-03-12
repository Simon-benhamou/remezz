import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import { AppMode } from '../store';

interface DailyReport {
  date: string;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  expectancy: number;
  maxDrawdown: number;
  profitFactor: number;
  sessionsCount: number;
  sessions: any[];
}

interface ReportsCacheData {
  reports: DailyReport[];
  sessions: any[];
  timestamp: number;
}

interface ReportsCache {
  [mode: string]: ReportsCacheData;
}

const REPORTS_CACHE_TTL = 30000; // 30 seconds TTL (reports change less frequently)
const AUTO_REFRESH_INTERVAL = 120000; // Auto refresh every 120s

export function useReportsCache() {
  const [isRefreshing, setIsRefreshing] = useState(false); // Background refresh indicator
  const [isInitialLoad, setIsInitialLoad] = useState(true); // First load shows spinner
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const cacheRef = useRef<ReportsCache>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isCacheValid = useCallback((mode: AppMode) => {
    const cached = cacheRef.current[mode];
    if (!cached) return false;
    return (Date.now() - cached.timestamp) < REPORTS_CACHE_TTL;
  }, []);

  const getCachedData = useCallback((mode: AppMode) => {
    const cached = cacheRef.current[mode];
    if (cached) {
      return { reports: cached.reports, sessions: cached.sessions };
    }
    return null;
  }, []);

  // Transform raw API data into grouped daily reports
  const transformReports = useCallback((sessionsData: any[], allReports: any[]): DailyReport[] => {
    // Group by day and aggregate
    const groupedByDay: Record<string, any> = {};

    for (const report of allReports) {
      const date = report.date;
      if (!groupedByDay[date]) {
        groupedByDay[date] = {
          date,
          totalTrades: 0,
          totalPnl: 0,
          sessions: [],
          winRates: [] as number[],
          expectancies: [] as number[]
        };
      }
      const dayData = groupedByDay[date];
      dayData.totalTrades += report.totalTrades;
      dayData.totalPnl += report.totalPnl;
      dayData.sessions.push(report);
      if (report.totalTrades > 0) {
        dayData.winRates.push(report.winRate);
        dayData.expectancies.push(report.expectancy);
      }
    }

    // Convert to array and compute averages
    return Object.values(groupedByDay).map((dayData: any) => {
      const avgWinRate = dayData.winRates.length > 0
        ? dayData.winRates.reduce((sum: number, wr: number) => sum + wr, 0) / dayData.winRates.length
        : 0;
      const avgExpectancy = dayData.expectancies.length > 0
        ? dayData.expectancies.reduce((sum: number, exp: number) => sum + exp, 0) / dayData.expectancies.length
        : 0;
      return {
        date: dayData.date,
        totalTrades: dayData.totalTrades,
        winRate: avgWinRate,
        totalPnl: dayData.totalPnl,
        expectancy: avgExpectancy,
        maxDrawdown: dayData.sessions.length > 0
          ? Math.min(...dayData.sessions.map((s: any) => s.maxDrawdown))
          : 0,
        profitFactor: avgExpectancy ? Math.max(1 + (avgExpectancy / 100), 0.1) : 1,
        sessionsCount: dayData.sessions.length,
        sessions: dayData.sessions
      };
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, []);

  const loadReports = useCallback(async (mode: AppMode, forceRefresh = false) => {
    // If we have cached data and not forcing refresh, check validity
    if (!forceRefresh && isCacheValid(mode)) {
      const cached = getCachedData(mode);
      if (cached) {
        if (import.meta.env.DEV) console.log(`🎯 Using cached reports for ${mode}`);
        setReports(cached.reports);
        setSessions(cached.sessions);
        return cached;
      }
    }

    // Show existing data if we have it (stale-while-revalidate)
    const existingData = getCachedData(mode);
    if (existingData) {
      // We have stale data - show it while refreshing in background
      setIsRefreshing(true);
      setReports(existingData.reports);
      setSessions(existingData.sessions);
    } else {
      // No data at all - show initial loading state
      setIsInitialLoad(true);
    }

    setError(null);

    try {
      if (import.meta.env.DEV) console.log(`🔄 Fetching fresh reports for ${mode}`);

      // Fetch sessions first
      const sessionsData = await api.listSessions(mode);
      const sessionsArray = Array.isArray(sessionsData) ? sessionsData : [];

      // Fetch all session reports in PARALLEL
      const reportPromises = sessionsArray.map(async (session: any) => {
        try {
          const sessionReports = await api.listDailyReports(session.id, 30);
          return sessionReports.map((report: any) => ({
            date: report.day,
            sessionId: report.sessionId,
            symbol: session.symbol,
            totalTrades: report.stats?.trades || 0,
            winRate: report.stats?.winRate || 0,
            totalPnl: report.stats?.pnlUsd || 0,
            avgWin: report.stats?.avgWin || 0,
            avgLoss: report.stats?.avgLoss || 0,
            expectancy: report.stats?.expectancy || 0,
            roiPct: report.stats?.roiPct || 0,
            maxDrawdown: -(Math.abs(report.stats?.pnlUsd || 0) * 0.15),
            profitFactor: report.stats?.expectancy ? Math.max(1 + (report.stats.expectancy / 100), 0.1) : 1,
            llmSummary: report.llm?.summary,
            createdAt: report.createdAt
          }));
        } catch (err) {
          console.warn(`Failed to load reports for session ${session.id}:`, err);
          return [];
        }
      });

      const reportArrays = await Promise.all(reportPromises);
      const allReports = reportArrays.flat();
      const transformedReports = transformReports(sessionsArray, allReports);

      // Cache the result
      cacheRef.current[mode] = {
        reports: transformedReports,
        sessions: sessionsArray,
        timestamp: Date.now()
      };

      if (import.meta.env.DEV) console.log(`✅ Cached ${transformedReports.length} daily reports for ${mode}`);

      setReports(transformedReports);
      setSessions(sessionsArray);

      return { reports: transformedReports, sessions: sessionsArray };
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || 'Failed to load reports';
      setError(errorMsg);
      console.error(`❌ Failed to load reports for ${mode}:`, err);
      throw err;
    } finally {
      setIsRefreshing(false);
      setIsInitialLoad(false);
    }
  }, [isCacheValid, getCachedData, transformReports]);

  const invalidateCache = useCallback((mode?: AppMode) => {
    if (mode !== undefined) {
      delete cacheRef.current[mode];
      if (import.meta.env.DEV) console.log(`🗑️ Invalidated reports cache for ${mode}`);
    } else {
      cacheRef.current = {};
      if (import.meta.env.DEV) console.log('🗑️ Invalidated all reports cache');
    }
  }, []);

  // Setup auto-refresh that runs in background
  const setupAutoRefresh = useCallback((mode: AppMode) => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      // Skip polling when tab is not visible
      if (document.hidden) return;
      if (!isCacheValid(mode)) {
        if (import.meta.env.DEV) console.log(`⏰ Auto-refresh triggered for reports ${mode}`);
        loadReports(mode, true).catch(console.error);
      }
    }, AUTO_REFRESH_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isCacheValid, loadReports]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return {
    reports,
    sessions,
    isRefreshing,      // True when updating data in background
    isInitialLoad,     // True only on first load (no cached data)
    error,
    loadReports,
    getCachedData,
    invalidateCache,
    setupAutoRefresh,
    isCacheValid
  };
}
