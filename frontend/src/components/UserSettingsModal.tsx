import React, { useState, useEffect } from 'react';
import { 
  Modal, 
  Tabs, 
  Form, 
  Input, 
  Button, 
  Space, 
  Card, 
  Typography, 
  message, 
  Divider,
  Select,
  Tag,
  Popconfirm,
  Alert,
  Switch
} from 'antd';
import {
  KeyOutlined,
  PlusOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  SafetyOutlined,
  SettingOutlined,
  UserOutlined,
} from '../icons';
import { api } from '../api';
import { useAppStore } from '../store';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt?: string;
}

interface ApiKey {
  id: string;
  exchange: string;
  keyName?: string;
  apiKey: string;
  isActive: boolean;
  createdAt: string;
}

interface UserSetting {
  id: string;
  key: string;
  value: string;
  category: string;
}

function PreferencesTab() {
  const { themeMode, toggleTheme } = useAppStore();

  return (
    <div style={{ padding: '20px 0' }}>
      <Card>
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          <div>
            <Title level={4}>Preferences</Title>
            <Paragraph type="secondary">
              Configure your display and notification settings.
            </Paragraph>
          </div>

          <Form layout="vertical">
            <Form.Item label="Appearance">
              <Space>
                <Switch
                  checked={themeMode === 'dark'}
                  onChange={toggleTheme}
                  checkedChildren="Dark"
                  unCheckedChildren="Light"
                />
                <Text>{themeMode === 'dark' ? 'Dark mode' : 'Light mode'}</Text>
              </Space>
            </Form.Item>

            <Form.Item label="Default Trading Mode">
              <Select defaultValue="paper" options={[
                { label: 'Paper Trading', value: 'paper' },
                { label: 'Live Trading', value: 'live' },
              ]} />
            </Form.Item>

            <Form.Item label="Risk Level">
              <Select defaultValue="moderate" options={[
                { label: 'Conservative', value: 'conservative' },
                { label: 'Moderate', value: 'moderate' },
                { label: 'Aggressive', value: 'aggressive' },
              ]} />
            </Form.Item>

            <Form.Item label="Notifications">
              <Space direction="vertical">
                <Space>
                  <Switch defaultChecked />
                  <Text>Trade alerts</Text>
                </Space>
                <Space>
                  <Switch defaultChecked />
                  <Text>Daily reports</Text>
                </Space>
                <Space>
                  <Switch />
                  <Text>Email notifications</Text>
                </Space>
              </Space>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
}

interface Props {
  visible: boolean;
  onClose: () => void;
  userInfo: UserInfo | null;
  onUserUpdate: () => void;
}

export default function UserSettingsModal({ visible, onClose, userInfo, onUserUpdate }: Props) {
  const [activeTab, setActiveTab] = useState('profile');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [settings, setSettings] = useState<UserSetting[]>([]);
  const [showApiKeys, setShowApiKeys] = useState<{ [key: string]: boolean }>({});
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  const [apiKeyForm] = Form.useForm();

  useEffect(() => {
    if (visible) {
      loadApiKeys();
      loadSettings();
    }
  }, [visible]);

  const loadApiKeys = async () => {
    try {
      const result = await api.client.get('/api/user/api-keys');
      setApiKeys(result.data.apiKeys || []);
    } catch (error) {
      console.error('Failed to load API keys:', error);
    }
  };

  const loadSettings = async () => {
    try {
      const result = await api.client.get('/api/user/settings');
      setSettings(result.data.settings || []);
    } catch (error) {
      console.error('Failed to load settings:', error);
    }
  };

  const handleAddApiKey = async (values: any) => {
    setLoading(true);
    try {
      await api.client.post('/api/user/api-keys', values);
      message.success('API Key added successfully');
      apiKeyForm.resetFields();
      loadApiKeys();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to add API key');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteApiKey = async (keyId: string) => {
    try {
      await api.client.delete(`/api/user/api-keys/${keyId}`);
      message.success('API Key deleted successfully');
      loadApiKeys();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to delete API key');
    }
  };

  const toggleShowApiKey = (keyId: string) => {
    setShowApiKeys(prev => ({
      ...prev,
      [keyId]: !prev[keyId]
    }));
  };

  const handleToggleApiKey = async (keyId: string) => {
    try {
      await api.client.patch(`/api/user/api-keys/${keyId}/toggle`);
      message.success('API key status updated');
      loadApiKeys();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to toggle API key');
    }
  };

  const exchangeOptions = [
    { label: 'Crypto.com', value: 'crypto.com' },
    { label: 'Binance', value: 'binance' },
  ];

  const maskedApiKey = (key: string) => {
    if (key.length <= 8) return '*'.repeat(key.length);
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  };

  const tabItems = [
    {
      key: 'profile',
      label: (
        <Space>
          <UserOutlined />
          Profile
        </Space>
      ),
      children: (
        <div style={{ padding: '20px 0' }}>
          <Card>
            <Space direction="vertical" style={{ width: '100%' }} size="large">
              <div>
                <Title level={4}>Profile Information</Title>
                <Paragraph type="secondary">
                  Manage your account details and preferences.
                </Paragraph>
              </div>
              
              <Form layout="vertical" initialValues={userInfo || {}}>
                <Form.Item label="Username" name="username">
                  <Input disabled />
                </Form.Item>
                <Form.Item label="Email" name="email">
                  <Input disabled />
                </Form.Item>
                <Form.Item label="Role" name="role">
                  <Input disabled />
                </Form.Item>
              </Form>

              <Alert
                message="Account Security"
                description="Your account uses secure JWT authentication. Contact support to modify your username or email."
                type="info"
                showIcon
              />
            </Space>
          </Card>
        </div>
      ),
    },
    {
      key: 'api-keys',
      label: (
        <Space>
          <KeyOutlined />
          API Keys
          {apiKeys.length > 0 && (
            <Tag color="blue" style={{ marginLeft: 4, fontSize: 10 }}>
              {apiKeys.length}
            </Tag>
          )}
        </Space>
      ),
      children: (
        <div style={{ padding: '20px 0' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <div>
              <Title level={4}>Exchange API Keys</Title>
              <Paragraph type="secondary">
                Securely store your exchange API keys for automated trading. All keys are encrypted.
              </Paragraph>
            </div>

            <Alert
              message="Secure API Key Management"
              description="Your API keys are encrypted and stored securely in the database. The system will automatically use your configured keys for trading operations instead of environment variables."
              type="info"
              showIcon
              icon={<SafetyOutlined />}
            />

            <Alert
              message="Server IP Whitelist Required"
              description={
                <div>
                  <Text style={{ fontSize: '13px' }}>
                    Add this IP to your Crypto.com API whitelist: 
                  </Text>
                  <br />
                  <Text 
                    code 
                    copyable 
                    style={{ 
                      fontSize: '14px', 
                      fontWeight: '600', 
                      color: 'var(--accent, #06b6d4)',
                      backgroundColor: 'rgba(6, 182, 212, 0.08)',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      border: '1px solid #d4edda'
                    }}
                  >
                    208.77.244.15
                  </Text>
                </div>
              }
              type="warning"
              showIcon
              style={{
                backgroundColor: 'rgba(245, 158, 11, 0.08)',
                border: '1px solid rgba(245, 158, 11, 0.3)'
              }}
            />

            <Alert
              message="Security Notice"
              description="Your API keys are encrypted and stored securely. Never share your API keys with anyone. Use read-only or trading permissions only."
              type="warning"
              showIcon
              icon={<SafetyOutlined />}
            />

            <Card title="Add New API Key" extra={<PlusOutlined />}>
              <Form
                form={apiKeyForm}
                layout="vertical"
                onFinish={handleAddApiKey}
              >
                <Form.Item
                  label="Exchange"
                  name="exchange"
                  rules={[{ required: true, message: 'Please select an exchange' }]}
                >
                  <Select
                    options={exchangeOptions}
                    placeholder="Select exchange"
                    showSearch
                  />
                </Form.Item>

                <Form.Item
                  label="Key Name (optional)"
                  name="keyName"
                  help="Give this key a name to identify it"
                >
                  <Input placeholder="e.g., Main Trading Account" />
                </Form.Item>

                <Form.Item
                  label="API Key"
                  name="apiKey"
                  rules={[{ required: true, message: 'Please enter your API key' }]}
                >
                  <Input.Password placeholder="Enter your API key" />
                </Form.Item>

                <Form.Item
                  label="API Secret"
                  name="apiSecret"
                  rules={[{ required: true, message: 'Please enter your API secret' }]}
                >
                  <Input.Password placeholder="Enter your API secret" />
                </Form.Item>

                <Alert
                  message="Whitelist Configuration"
                  description={
                    <div>
                      <Text style={{ fontSize: '12px' }}>
                        Before using your API key, make sure to add our server IP to your Crypto.com whitelist:
                      </Text>
                      <br />
                      <Text 
                        code 
                        copyable 
                        style={{ 
                          fontSize: '13px', 
                          fontWeight: '600', 
                          color: 'var(--accent, #06b6d4)',
                          marginTop: '4px',
                          display: 'inline-block'
                        }}
                      >
                        208.77.244.15
                      </Text>
                      <br />
                      <Text style={{ fontSize: '11px', color: 'var(--text-secondary, #94a3b8)', marginTop: '4px' }}>
                        Go to Crypto.com → API Management → Edit your API → IP Whitelist
                      </Text>
                    </div>
                  }
                  type="info"
                  showIcon={false}
                  style={{
                    background: 'rgba(16, 185, 129, 0.08)',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    borderRadius: '6px',
                    marginBottom: '16px'
                  }}
                />

                <Form.Item>
                  <Button type="primary" htmlType="submit" loading={loading} icon={<PlusOutlined />}>
                    Add API Key
                  </Button>
                </Form.Item>
              </Form>
            </Card>

            <Card title="Your API Keys">
              {apiKeys.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <KeyOutlined style={{ fontSize: 48, color: '#d9d9d9', marginBottom: 16 }} />
                  <div style={{ color: '#999', fontSize: 16 }}>No API keys configured</div>
                  <div style={{ color: '#ccc', fontSize: 14 }}>Add your first exchange API key above</div>
                </div>
              ) : (
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                  {apiKeys.map((key) => (
                    <Card
                      key={key.id}
                      size="small"
                      style={{ backgroundColor: 'rgba(6, 182, 212, 0.04)' }}
                      extra={
                        <Space>
                          <Button
                            type="text"
                            size="small"
                            icon={showApiKeys[key.id] ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                            onClick={() => toggleShowApiKey(key.id)}
                          />
                          <Popconfirm
                            title="Delete API Key"
                            description="Are you sure you want to delete this API key? This action cannot be undone."
                            onConfirm={() => handleDeleteApiKey(key.id)}
                            okText="Delete"
                            cancelText="Cancel"
                            okButtonProps={{ danger: true }}
                          >
                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      }
                    >
                      <Space direction="vertical" style={{ width: '100%' }} size="small">
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Space>
                            <Tag color="blue">{key.exchange}</Tag>
                            <Switch
                              checked={key.isActive}
                              onChange={() => handleToggleApiKey(key.id)}
                              checkedChildren="Active"
                              unCheckedChildren="Inactive"
                            />
                          </Space>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Added {new Date(key.createdAt).toLocaleDateString()}
                          </Text>
                        </div>
                        
                        {key.keyName && (
                          <Text strong>{key.keyName}</Text>
                        )}
                        
                        <div>
                          <Text code style={{ fontSize: 12 }}>
                            {showApiKeys[key.id] ? key.apiKey : maskedApiKey(key.apiKey)}
                          </Text>
                        </div>
                      </Space>
                    </Card>
                  ))}
                </Space>
              )}
            </Card>
          </Space>
        </div>
      ),
    },
    {
      key: 'preferences',
      label: (
        <Space>
          <SettingOutlined />
          Preferences
        </Space>
      ),
      children: <PreferencesTab />,
    },
  ];

  return (
    <Modal
      title="User Settings"
      open={visible}
      onCancel={onClose}
      footer={null}
      width={800}
      style={{ top: 20 }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        size="large"
      />
    </Modal>
  );
}
