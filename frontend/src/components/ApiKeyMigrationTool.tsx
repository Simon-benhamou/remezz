import React, { useState, useEffect } from 'react';
import { Card, Button, Space, Typography, Alert, Table, Modal, Form, Input, message, Tag } from 'antd';
import { ToolOutlined, ReloadOutlined, ExclamationCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { api } from '../api';

const { Title, Text } = Typography;

export default function ApiKeyMigrationTool() {
  const [loading, setLoading] = useState(false);
  const [keys, setKeys] = useState<any[]>([]);
  const [migrationModal, setMigrationModal] = useState(false);
  const [selectedKey, setSelectedKey] = useState<any>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    checkRawKeys();
  }, []);

  const checkRawKeys = async () => {
    setLoading(true);
    try {
      const response = await api.client.get('/api/debug/raw-keys');
      if (response.data.success) {
        setKeys(response.data.keys || []);
      }
    } catch (error: any) {
      message.error('Failed to check API keys: ' + (error?.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  const handleMigration = async (values: any) => {
    try {
      const response = await api.client.post('/api/debug/migrate-keys', {
        keyId: selectedKey.id,
        newApiKey: values.apiKey,
        newApiSecret: values.apiSecret
      });

      if (response.data.success) {
        message.success('API key migrated successfully!');
        setMigrationModal(false);
        form.resetFields();
        checkRawKeys(); // Refresh the list
      }
    } catch (error: any) {
      message.error('Migration failed: ' + (error?.response?.data?.error || error.message));
    }
  };

  const columns = [
    {
      title: 'Exchange',
      dataIndex: 'exchange',
      key: 'exchange',
      render: (exchange: string) => <Tag color="blue">{exchange}</Tag>
    },
    {
      title: 'Key Name',
      dataIndex: 'keyName',
      key: 'keyName',
      render: (name: string) => name || <Text type="secondary">Unnamed</Text>
    },
    {
      title: 'Decryption Status',
      dataIndex: 'decryptionSuccess',
      key: 'decryptionSuccess',
      render: (success: boolean) => success ? 
        <Tag color="green" icon={<CheckCircleOutlined />}>OK</Tag> :
        <Tag color="red" icon={<CloseCircleOutlined />}>Failed</Tag>
    },
    {
      title: 'Error',
      dataIndex: 'decryptionError',
      key: 'decryptionError',
      render: (error: string) => error ? 
        <Text type="danger" style={{ fontSize: '12px' }}>{error}</Text> : 
        null
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => new Date(date).toLocaleDateString()
    },
    {
      title: 'Action',
      key: 'action',
      render: (_: any, record: any) => !record.decryptionSuccess ? (
        <Button 
          size="small" 
          type="primary"
          onClick={() => {
            setSelectedKey(record);
            setMigrationModal(true);
          }}
        >
          Fix
        </Button>
      ) : null
    }
  ];

  const hasFailedKeys = keys.some(key => !key.decryptionSuccess);

  return (
    <Card 
      title={
        <Space>
          <ToolOutlined />
          API Key Migration Tool
        </Space>
      }
      extra={
        <Button 
          icon={<ReloadOutlined />} 
          onClick={checkRawKeys}
          loading={loading}
        >
          Refresh
        </Button>
      }
      style={{ margin: '16px 0' }}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {hasFailedKeys && (
          <Alert
            message="API Key Issues Detected"
            description="Some of your API keys cannot be decrypted. This happened because the encryption algorithm was updated. You need to re-enter your API keys to fix this."
            type="error"
            showIcon
            icon={<ExclamationCircleOutlined />}
          />
        )}

        {keys.length === 0 ? (
          <Alert
            message="No API Keys Found"
            description="You don't have any API keys configured yet. Please add your Crypto.com API keys in Settings."
            type="info"
            showIcon
          />
        ) : (
          <Table
            dataSource={keys}
            columns={columns}
            rowKey="id"
            size="small"
            pagination={false}
          />
        )}

        <Alert
          message="Migration Process"
          description={
            <div>
              <Text>If you have failed keys:</Text>
              <ol style={{ margin: '8px 0', paddingLeft: '20px' }}>
                <li>Click "Fix" next to the failed key</li>
                <li>Re-enter your original API Key and Secret from Crypto.com</li>
                <li>The key will be re-encrypted with the new secure algorithm</li>
              </ol>
            </div>
          }
          type="info"
          showIcon
        />
      </Space>

      <Modal
        title="Fix API Key"
        open={migrationModal}
        onCancel={() => {
          setMigrationModal(false);
          form.resetFields();
        }}
        footer={null}
      >
        <Alert
          message="Re-enter Your API Credentials"
          description={`Please re-enter the API Key and Secret for ${selectedKey?.exchange} (${selectedKey?.keyName || 'Unnamed'})`}
          type="warning"
          style={{ marginBottom: '16px' }}
        />

        <Form
          form={form}
          layout="vertical"
          onFinish={handleMigration}
        >
          <Form.Item
            label="API Key"
            name="apiKey"
            rules={[{ required: true, message: 'Please enter your API key' }]}
          >
            <Input.Password placeholder="Enter your Crypto.com API Key" />
          </Form.Item>

          <Form.Item
            label="API Secret"
            name="apiSecret"
            rules={[{ required: true, message: 'Please enter your API secret' }]}
          >
            <Input.Password placeholder="Enter your Crypto.com API Secret" />
          </Form.Item>

          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                Fix API Key
              </Button>
              <Button onClick={() => setMigrationModal(false)}>
                Cancel
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}