import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, expect, vi, beforeEach, afterEach, it, Mock } from 'vitest';
import { useStopAllConfirmation } from '../useStopAllConfirmation';
import { api } from '../../api';
import { STOP_ALL_LOCK_STORAGE_KEY } from '../useStopAllLock';

vi.mock('../../api', () => ({
  api: {
    stopAllAgents: vi.fn(),
  },
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const noop = () => {};

function TestComponent({ onSuccess = noop }: { onSuccess?: (payload: any) => void }) {
  const confirmStopAll = useStopAllConfirmation();
  return <button onClick={() => confirmStopAll({ onSuccess })}>stop-all</button>;
}

describe('useStopAllConfirmation', () => {
  beforeEach(() => {
    (api.stopAllAgents as unknown as Mock).mockResolvedValue({ stopped: 2, results: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    localStorage.removeItem(STOP_ALL_LOCK_STORAGE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(STOP_ALL_LOCK_STORAGE_KEY);
  });

  it('confirms stop-all and locks creation on success', async () => {
    const onSuccess = vi.fn();
    const { getByText } = render(<TestComponent onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(getByText('stop-all'));
      // Allow the async IIFE to settle
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.stopAllAgents).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STOP_ALL_LOCK_STORAGE_KEY)).toBe('true');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('does nothing when user cancels confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const onSuccess = vi.fn();
    const { getByText } = render(<TestComponent onSuccess={onSuccess} />);

    await act(async () => {
      fireEvent.click(getByText('stop-all'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(api.stopAllAgents).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
