import React from 'react';
import { toast } from '@/lib/toast';
import { api } from '../api';
import { useStopAllLock } from './useStopAllLock';

type StopAllConfirmationOptions = {
  description?: React.ReactNode;
  onSuccess?: (response: any) => void;
  onError?: (error: unknown) => void;
};

export function useStopAllConfirmation(defaultOptions?: { description?: React.ReactNode }) {
  const { lock } = useStopAllLock();

  return React.useCallback(
    (options?: StopAllConfirmationOptions) => {
      const confirmed = window.confirm(
        'Emergency stop all agents?\n\n' +
        'This will immediately halt every active agent, cancel open orders, and flatten positions. ' +
        'Trading will remain disabled until you reset the control center.'
      );

      if (!confirmed) return;

      (async () => {
        try {
          const response = await api.stopAllAgents();
          lock();
          const failures = Array.isArray(response?.results)
            ? response.results.filter((r: any) => Array.isArray(r?.errors) && r.errors.length > 0)
            : [];
          if (failures.length > 0) {
            toast.warning(`Halted ${response?.stopped ?? 0} sessions with ${failures.length} warnings.`);
          } else {
            toast.success(`Halted ${response?.stopped ?? 0} sessions successfully.`);
          }
          options?.onSuccess?.(response);
        } catch (error) {
          toast.error('Failed to halt agents. Please retry.');
          options?.onError?.(error);
        }
      })();
    },
    [defaultOptions?.description, lock],
  );
}
