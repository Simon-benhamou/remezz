import React from 'react';

type Mode = 'live' | 'paper';

type ModeContextValue = {
  mode: Mode;
  setMode: (mode: Mode) => void;
};

const ModeContext = React.createContext<ModeContextValue | undefined>(undefined);

const STORAGE_KEY = 'appMode';

function normalize(value: any): Mode {
  return value === 'paper' ? 'paper' : 'live';
}

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = React.useState<Mode>(() => {
    if (typeof window === 'undefined') return 'live';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return normalize(stored);
  });

  const setMode = React.useCallback((next: Mode) => {
    setModeState(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next);
    }
  }, []);

  const value = React.useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = React.useContext(ModeContext);
  if (!ctx) {
    throw new Error('useMode must be used within ModeProvider');
  }
  return ctx;
}
