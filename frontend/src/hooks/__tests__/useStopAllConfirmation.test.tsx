import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, expect, vi, beforeEach, afterEach, afterAll, it } from 'vitest';
import { Modal, message } from 'antd';
import { useStopAllConfirmation } from '../useStopAllConfirmation';
import { api } from '../../api';
import { STOP_ALL_LOCK_STORAGE_KEY } from '../useStopAllLock';

vi.mock('../../api', () => ({
  api: {
    stopAllAgents: vi.fn(),
  },
}));

const noop = () => {};

function TestComponent({ onSuccess = noop }: { onSuccess?: (payload: any) => void }) {
  const confirmStopAll = useStopAllConfirmation();
  return <button onClick={() => confirmStopAll({ onSuccess })}>stop-all</button>;
}

describe('useStopAllConfirmation', () => {
  const confirmSpy = vi.spyOn(Modal, 'confirm');
  const successSpy = vi.spyOn(message, 'success');
  const warningSpy = vi.spyOn(message, 'warning');
  const errorSpy = vi.spyOn(message, 'error');

  beforeEach(() => {
    (api.stopAllAgents as unknown as vi.Mock).mockResolvedValue({ stopped: 2, results: [] });
    confirmSpy.mockClear();
    successSpy.mockClear();
    warningSpy.mockClear();
    errorSpy.mockClear();
    localStorage.removeItem(STOP_ALL_LOCK_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(STOP_ALL_LOCK_STORAGE_KEY);
  });

  afterAll(() => {
    confirmSpy.mockRestore();
    successSpy.mockRestore();
    warningSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('confirms stop-all and locks creation on success', async () => {
    let capturedConfig: Parameters<typeof Modal.confirm>[0] | undefined;
    confirmSpy.mockImplementationOnce((config) => {
      capturedConfig = config;
      return {} as any;
    });

    const onSuccess = vi.fn();
    const { getByText } = render(<TestComponent onSuccess={onSuccess} />);

    fireEvent.click(getByText('stop-all'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(capturedConfig).toBeTruthy();

    await act(async () => {
      await capturedConfig?.onOk?.();
    });

    expect(api.stopAllAgents).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(STOP_ALL_LOCK_STORAGE_KEY)).toBe('true');
    expect(successSpy).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
    expect(warningSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
