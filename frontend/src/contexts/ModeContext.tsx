import React from 'react';
import { useAppStore, type AppMode } from '../store';

type ModeContextValue = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
};

const ModeContext = React.createContext<ModeContextValue | undefined>(undefined);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);

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
