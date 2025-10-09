import React from 'react';
import { Modal, message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';
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
      Modal.confirm({
        title: 'Emergency stop all agents?',
        icon: <ExclamationCircleOutlined style={{ color: '#faad14' }} />,
        centered: true,
        content:
          options?.description ??
          defaultOptions?.description ??
          'This will immediately halt every active agent, cancel open orders, and flatten positions. Trading will remain disabled until you reset the control center.',
        okText: 'Halt everything',
        okButtonProps: { danger: true },
        cancelText: 'Keep running',
        async onOk() {
          try {
            const response = await api.stopAllAgents();
            lock();
            const failures = Array.isArray(response?.results)
              ? response.results.filter((r: any) => Array.isArray(r?.errors) && r.errors.length > 0)
              : [];
            if (failures.length > 0) {
              message.warning(`Halted ${response?.stopped ?? 0} sessions with ${failures.length} warnings.`);
            } else {
              message.success(`Halted ${response?.stopped ?? 0} sessions successfully.`);
            }
            options?.onSuccess?.(response);
            return response;
          } catch (error) {
            message.error('Failed to halt agents. Please retry.');
            options?.onError?.(error);
            throw error;
          }
        },
      });
    },
    [defaultOptions?.description, lock],
  );
}
