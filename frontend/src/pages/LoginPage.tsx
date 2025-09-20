import React, { useState } from 'react';
import { Card, Form, Input, Button, Typography, Space, message, Divider, Alert } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { api, getApiKey, setApiKey } from '../api';

const { Title, Text } = Typography;

export default function LoginPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  React.useEffect(() => {
    if (getApiKey()) navigate('/dashboard', { replace: true });
  }, [navigate]);

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      const result = await api.auth.login(values.username, values.password);
      if (result.token) {
        setApiKey(result.token);
        message.success(`Welcome back, ${result.user.username}!`);
        navigate('/dashboard', { replace: true });
      }
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || 'Login failed';
      const errorMessages: { [key: string]: string } = {
        'invalid_credentials': 'Invalid username or password',
        'server_error': 'Server error, please try again later'
      };
      const friendlyMessage = errorMessages[errorMessage] || errorMessage;
      
      message.error(friendlyMessage);
    } finally {
      setLoading(false);
    }
  };

  // Legacy code access for backwards compatibility
  const legacyCodeLogin = async () => {
    const code = prompt('Enter access code:');
    if (!code) return;
    
    setLoading(true);
    try {
      const out = (await api.client.post('/api/auth/login', { code })).data;
      if (out?.token) {
        setApiKey(out.token);
        message.success('Logged in');
        navigate('/dashboard', { replace: true });
      }
    } catch (e: any) {
      message.error('Invalid access code');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px'
    }}>
      <Card
        style={{
          width: '100%',
          maxWidth: '400px',
          borderRadius: '16px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.1)',
          border: 'none'
        }}
        bodyStyle={{ padding: '40px' }}
      >
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 16px auto',
            fontSize: '28px',
            fontWeight: '700',
            color: 'white',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
          }}>
            Q
          </div>
          <Title level={2} style={{ 
            margin: '0 0 8px 0',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif'
          }}>
            Welcome Back
          </Title>
          <Text type="secondary" style={{ fontSize: '16px' }}>
            Sign in to your trading dashboard
          </Text>
        </div>

        <Form
          form={form}
          name="login"
          onFinish={onFinish}
          layout="vertical"
          size="large"
          style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif' }}
        >
          <Form.Item
            name="username"
            label="Username"
            rules={[{ required: true, message: 'Please input your username!' }]}
          >
            <Input
              prefix={<UserOutlined style={{ color: '#667eea' }} />}
              placeholder="Enter your username"
              style={{
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '16px',
                padding: '12px'
              }}
            />
          </Form.Item>

          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Please input your password!' }]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#667eea' }} />}
              placeholder="Enter your password"
              style={{
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '16px',
                padding: '12px'
              }}
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: '16px' }}>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              style={{
                width: '100%',
                height: '48px',
                borderRadius: '8px',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none',
                fontSize: '16px',
                fontWeight: '600',
                boxShadow: '0 4px 12px rgba(102, 126, 234, 0.4)'
              }}
            >
              Sign In
            </Button>
          </Form.Item>
        </Form>

        <Divider style={{ margin: '24px 0' }}>
          <Text type="secondary" style={{ fontSize: '14px' }}>
            New to our platform?
          </Text>
        </Divider>

        <div style={{ textAlign: 'center', marginBottom: '16px' }}>
          <Link to="/register">
            <Button
              style={{
                width: '100%',
                height: '48px',
                borderRadius: '8px',
                border: '2px solid #667eea',
                color: '#667eea',
                fontSize: '16px',
                fontWeight: '600',
                background: 'transparent'
              }}
            >
              Create Account
            </Button>
          </Link>
        </div>

        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <Button
            type="link"
            onClick={legacyCodeLogin}
            style={{ color: '#667eea', fontSize: '14px' }}
          >
            Login with Access Code
          </Button>
        </div>

        <div style={{ textAlign: 'center' }}>
          <Alert
            message="Demo Access"
            description={
              <div>
                <Text style={{ fontSize: '12px', color: '#64748b' }}>
                  For testing: admin / admin
                </Text>
              </div>
            }
            type="info"
            showIcon={false}
            style={{
              background: 'linear-gradient(135deg, #f0f9ff, #e0f2fe)',
              border: '1px solid #bae6fd',
              borderRadius: '8px'
            }}
          />
        </div>
      </Card>
    </div>
  );
}
