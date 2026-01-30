import React from 'react';

export const STOP_ALL_LOCK_STORAGE_KEY = 'remezz.stopAll.lock';
export const STOP_ALL_LOCK_EVENT = 'remezz:stopAllLockChanged';

function readLockState(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STOP_ALL_LOCK_STORAGE_KEY) === 'true';
}

export function useStopAllLock() {
  const [locked, setLockedState] = React.useState<boolean>(() => readLockState());

  const setLocked = React.useCallback((value: boolean) => {
    if (typeof window === 'undefined') return;
    if (value) {
      window.localStorage.setItem(STOP_ALL_LOCK_STORAGE_KEY, 'true');
    } else {
      window.localStorage.removeItem(STOP_ALL_LOCK_STORAGE_KEY);
    }
    setLockedState(value);
    window.dispatchEvent(new CustomEvent(STOP_ALL_LOCK_EVENT, { detail: value }));
  }, []);

  const lock = React.useCallback(() => setLocked(true), [setLocked]);
  const unlock = React.useCallback(() => setLocked(false), [setLocked]);

  React.useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STOP_ALL_LOCK_STORAGE_KEY) {
        setLockedState(event.newValue === 'true');
      }
    };
    const handleCustom = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;
      if (typeof detail === 'boolean') {
        setLockedState(detail);
      }
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener(STOP_ALL_LOCK_EVENT, handleCustom as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(STOP_ALL_LOCK_EVENT, handleCustom as EventListener);
    };
  }, []);

  return { locked, lock, unlock, setLocked } as const;
}
