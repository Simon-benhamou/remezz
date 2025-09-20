import React, { useState } from 'react';
import { Card, Button, Space, Typography, Alert, Collapse, Tag, Divider } from 'antd';
import { BugOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

export default function ApiKeyDiagnostics() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any>(null);

  const runDiagnostics = async () => {
    setLoading(true);
    try {
      const response = await api.client.get('/api/debug/test-balance');
      setResults(response.data);
    } catch (error: any) {
      setResults({
        success: false,
        error: error?.response?.data || error.message || String(error)
      });
    } finally {
      setLoading(false);
    }
  };

  const getStatusIcon = (success: boolean) => {
    return success ? 
      <CheckCircleOutlined style={{ color: '#52c41a' }} /> : 
      <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
  };

  const getStatusColor = (success: boolean) => {
    return success ? 'success' : 'error';
  };

  return (
    <Card 
      title={
        <Space>
          <BugOutlined />
          API Keys Diagnostics
        </Space>
      }
      style={{ margin: '16px 0' }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <Alert
          message="Diagnostic Tool"
          description="This tool will test your Crypto.com API keys and help identify any configuration issues."
          type="info"
          showIcon
        />

        <Button
          type="primary"
          icon={loading ? <LoadingOutlined /> : <BugOutlined />}
          onClick={runDiagnostics}
          loading={loading}
          size="large"
          style={{
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            border: 'none'
          }}
        >
          Run Diagnostics
        </Button>

        {results && (
          <div>
            <Divider>Results</Divider>
            
            {!results.success ? (
              <Alert
                message="Diagnostics Failed"
                description={JSON.stringify(results.error)}
                type="error"
                showIcon
              />
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                {/* Credentials Info */}
                <Card size="small" title="Credentials Info">
                  <Space wrap>
                    <Tag>API Key: {results.credentials?.apiKeyLength} chars</Tag>
                    <Tag>API Secret: {results.credentials?.apiSecretLength} chars</Tag>
                    <Tag color={results.credentials?.testnet ? 'orange' : 'blue'}>
                      {results.credentials?.testnet ? 'Testnet' : 'Mainnet'}
                    </Tag>
                  </Space>
                </Card>

                {/* Test Results */}
                <Collapse>
                  <Panel 
                    header={
                      <Space>
                        {getStatusIcon(results.tests?.validation?.success)}
                        <Text strong>Credentials Validation</Text>
                        <Tag color={getStatusColor(results.tests?.validation?.success)}>
                          {results.tests?.validation?.success ? 'PASS' : 'FAIL'}
                        </Tag>
                      </Space>
                    }
                    key="validation"
                  >
                    {results.tests?.validation?.error ? (
                      <Alert
                        message="Validation Error"
                        description={results.tests.validation.error}
                        type="error"
                        style={{ margin: '8px 0' }}
                      />
                    ) : (
                      <Alert
                        message="Credentials Valid"
                        description="Your API keys are properly formatted and accepted by Crypto.com"
                        type="success"
                        style={{ margin: '8px 0' }}
                      />
                    )}
                  </Panel>

                  <Panel 
                    header={
                      <Space>
                        {getStatusIcon(results.tests?.balance?.success)}
                        <Text strong>Balance Fetch</Text>
                        <Tag color={getStatusColor(results.tests?.balance?.success)}>
                          {results.tests?.balance?.success ? 'PASS' : 'FAIL'}
                        </Tag>
                      </Space>
                    }
                    key="balance"
                  >
                    {results.tests?.balance?.success ? (
                      <div>
                        <Alert
                          message="Balance Retrieved Successfully"
                          description="Your API keys have sufficient permissions to fetch balance"
                          type="success"
                          style={{ margin: '8px 0' }}
                        />
                        {results.tests.balance.data && (
                          <div style={{ marginTop: '16px' }}>
                            <Title level={5}>Balance Data:</Title>
                            <pre style={{ 
                              background: '#f5f5f5', 
                              padding: '12px', 
                              borderRadius: '4px',
                              fontSize: '12px',
                              overflow: 'auto',
                              maxHeight: '200px'
                            }}>
                              {JSON.stringify(results.tests.balance.data, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    ) : (
                      <Alert
                        message="Balance Fetch Failed"
                        description={results.tests?.balance?.error || 'Unknown error'}
                        type="error"
                        style={{ margin: '8px 0' }}
                      />
                    )}
                  </Panel>

                  <Panel 
                    header={
                      <Space>
                        {getStatusIcon(results.tests?.status?.success)}
                        <Text strong>Exchange Status</Text>
                        <Tag color={getStatusColor(results.tests?.status?.success)}>
                          {results.tests?.status?.success ? 'PASS' : 'FAIL'}
                        </Tag>
                      </Space>
                    }
                    key="status"
                  >
                    {results.tests?.status?.success ? (
                      <div>
                        <Alert
                          message="Exchange Status Retrieved"
                          type="success"
                          style={{ margin: '8px 0' }}
                        />
                        {results.tests.status.data && (
                          <pre style={{ 
                            background: '#f5f5f5', 
                            padding: '12px', 
                            borderRadius: '4px',
                            fontSize: '12px'
                          }}>
                            {JSON.stringify(results.tests.status.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    ) : (
                      <Alert
                        message="Status Fetch Failed"
                        description={results.tests?.status?.error || 'Unknown error'}
                        type="error"
                        style={{ margin: '8px 0' }}
                      />
                    )}
                  </Panel>
                </Collapse>
              </Space>
            )}
          </div>
        )}

        <Alert
          message="Common Issues"
          description={
            <div>
              <Paragraph style={{ margin: 0 }}>
                <Text strong>If tests fail:</Text>
              </Paragraph>
              <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>
                <li>Check that your API keys are correct</li>
                <li>Verify IP whitelist includes: <Text code>208.77.244.15</Text></li>
                <li>Ensure API has trading permissions enabled</li>
                <li>Try deleting and re-adding your API keys</li>
              </ul>
            </div>
          }
          type="warning"
          showIcon
        />
      </Space>
    </Card>
  );
}