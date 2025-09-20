import React, { useState, useEffect } from 'react';
import { Alert, Button, Space, Typography, Card } from 'antd';
import { WarningOutlined, KeyOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Text, Title } = Typography;

interface ApiKeyStatus {
  hasApiKeys: boolean;
  isValid: boolean;
  canUseLive: boolean;
  message: string;
}

interface Props {
  onConfigureKeys?: () => void;
  mode?: 'live' | 'paper';
  style?: React.CSSProperties;
  showTitle?: boolean;
}

export default function ApiKeyStatusBanner({ onConfigureKeys, mode, style, showTitle = true }: Props) {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkApiKeyStatus();
  }, []);

  const checkApiKeyStatus = async () => {
    try {
      setLoading(true);
      const result = await api.client.get('/api/user/api-keys/status');
      setStatus(result.data);
    } catch (error) {
      console.error('Failed to check API key status:', error);
      setStatus({
        hasApiKeys: false,
        isValid: false,
        canUseLive: false,
        message: 'Failed to check API key status'
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) return null;
  if (!status) return null;

  // Only show warnings for live mode or when there are issues
  if (mode === 'paper' && status.hasApiKeys && status.isValid) return null;

  const getAlertType = () => {
    if (!status.hasApiKeys) return 'warning';
    if (!status.isValid) return 'error';
    return 'success';
  };

  const getIcon = () => {
    if (!status.hasApiKeys) return <KeyOutlined />;
    if (!status.isValid) return <CloseCircleOutlined />;
    return <CheckCircleOutlined />;
  };

  const getTitle = () => {
    if (!status.hasApiKeys) return 'API Keys Required for Live Trading';
    if (!status.isValid) return 'API Keys Configuration Issue';
    return 'API Keys Configured';
  };

  const getDescription = () => {
    if (!status.hasApiKeys) {
      return (
        <div>
          <Text>
            To use live trading, you need to configure your Crypto.com API keys.
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: '12px' }}>
            Make sure to whitelist our server IP: <Text code>208.77.244.15</Text>
          </Text>
        </div>
      );
    }

    if (!status.isValid) {
      return (
        <div>
          <Text>
            Your API keys appear to be invalid or have insufficient permissions.
          </Text>
          <br />
          <Text type="secondary" style={{ fontSize: '12px' }}>
            Please check: 1) Keys are correct 2) IP whitelist includes: <Text code>208.77.244.15</Text> 3) Trading permissions enabled
          </Text>
        </div>
      );
    }

    return (
      <Text>
        Your Crypto.com API keys are configured and working correctly.
      </Text>
    );
  };

  const shouldShowBanner = !status.hasApiKeys || !status.isValid || (mode === 'live' && !status.canUseLive);

  if (!shouldShowBanner) return null;

  return (
    <div style={style}>
      {showTitle && (
        <Title level={4} style={{ marginBottom: '16px', color: '#1f2937' }}>
          <WarningOutlined style={{ marginRight: '8px', color: '#f59e0b' }} />
          Trading Configuration
        </Title>
      )}
      
      <Alert
        message={getTitle()}
        description={getDescription()}
        type={getAlertType()}
        icon={getIcon()}
        showIcon
        style={{
          borderRadius: '8px',
          marginBottom: '16px'
        }}
        action={
          (!status.hasApiKeys || !status.isValid) && (
            <Space direction="vertical" size="small">
              <Button
                type="primary"
                size="small"
                onClick={onConfigureKeys}
                style={{
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  border: 'none'
                }}
              >
                Configure API Keys
              </Button>
              <Button
                type="link"
                size="small"
                onClick={checkApiKeyStatus}
                style={{ padding: 0, height: 'auto' }}
              >
                Recheck Status
              </Button>
            </Space>
          )
        }
      />

      {mode === 'live' && !status.canUseLive && (
        <Alert
          message="Live Trading Disabled"
          description="Live trading is disabled until valid API keys are configured. You can still use paper trading mode."
          type="warning"
          showIcon
          style={{
            borderRadius: '8px',
            backgroundColor: '#fff7e6',
            border: '1px solid #ffd591'
          }}
        />
      )}
    </div>
  );
}