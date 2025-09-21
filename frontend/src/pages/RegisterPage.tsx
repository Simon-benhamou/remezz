import React, { useState } from 'react';
import { Card, Form, Input, Button, Typography, Space, message, Divider, Alert } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined, KeyOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { api, setApiKey } from '../api';

const { Title, Text } = Typography;

export default function RegisterPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      const { username, email, password, registrationCode } = values;
      const result = await api.client.post('/api/auth/register', {
        username,
        email,
        password,
        registrationCode
      });

      if (result.data.token) {
        setApiKey(result.data.token);
        message.success(`Welcome to Quantum Trading, ${result.data.user.username}!`);
        
        // Navigation immédiate avec React Router
        navigate('/dashboard', { replace: true });
      }
    } catch (error: any) {
      const errorMessage = error?.response?.data?.error || 'Registration failed';
      const errorMessages: { [key: string]: string } = {
        'missing_required_fields': 'Please fill in all required fields',
        'invalid_registration_code': 'Invalid registration code. Please contact administrator.',
        'username_must_be_3_20_chars': 'Username must be between 3 and 20 characters',
        'password_must_be_at_least_6_chars': 'Password must be at least 6 characters',
        'invalid_email_format': 'Please enter a valid email address',
        'username_already_exists': 'Username is already taken',
        'email_already_exists': 'Email is already registered',
        'server_error': 'Server error, please try again later'
      };
      const friendlyMessage = errorMessages[errorMessage] || errorMessage;
      
      message.error(friendlyMessage);
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
          maxWidth: '420px',
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
            Create Account
          </Title>
          <Text type="secondary" style={{ fontSize: '16px' }}>
            Join the future of algorithmic trading
          </Text>
        </div>

        <Form
          form={form}
          name="register"
          onFinish={onFinish}
          layout="vertical"
          size="large"
          style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", sans-serif' }}
        >
          <Form.Item
            name="registrationCode"
            label="Registration Code"
            rules={[
              { required: true, message: 'Registration code is required!' },
              { len: 9, message: 'Registration code must be exactly 9 characters' }
            ]}
          >
            <Input
              prefix={<KeyOutlined style={{ color: '#667eea' }} />}
              placeholder="Enter registration code"
              style={{
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '16px',
                padding: '12px'
              }}
            />
          </Form.Item>

          <Form.Item
            name="username"
            label="Username"
            rules={[
              { required: true, message: 'Please input your username!' },
              { min: 3, message: 'Username must be at least 3 characters' },
              { max: 20, message: 'Username must be less than 20 characters' },
              { pattern: /^[a-zA-Z0-9_]+$/, message: 'Username can only contain letters, numbers, and underscores' }
            ]}
          >
            <Input
              prefix={<UserOutlined style={{ color: '#667eea' }} />}
              placeholder="Choose a username"
              style={{
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '16px',
                padding: '12px'
              }}
            />
          </Form.Item>

          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: 'Please input your email!' },
              { type: 'email', message: 'Please enter a valid email address!' }
            ]}
          >
            <Input
              prefix={<MailOutlined style={{ color: '#667eea' }} />}
              placeholder="Enter your email"
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
            rules={[
              { required: true, message: 'Please input your password!' },
              { min: 6, message: 'Password must be at least 6 characters' }
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#667eea' }} />}
              placeholder="Create a strong password"
              style={{
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '16px',
                padding: '12px'
              }}
            />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            label="Confirm Password"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Please confirm your password!' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('Passwords do not match!'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: '#667eea' }} />}
              placeholder="Confirm your password"
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
              Create Account
            </Button>
          </Form.Item>
        </Form>

        <div style={{ marginBottom: '24px' }}>
          <Alert
            message="Registration Code Required"
            description={
              <div>
                <Text style={{ fontSize: '12px', color: '#64748b' }}>
                  You need a valid registration code to create an account. Contact the administrator if you don't have one.
                </Text>
              </div>
            }
            type="warning"
            showIcon={false}
            style={{
              background: 'linear-gradient(135deg, #fef3cd, #fef3cd)',
              border: '1px solid #f59e0b',
              borderRadius: '8px'
            }}
          />
        </div>

        <Divider style={{ margin: '24px 0' }}>
          <Text type="secondary" style={{ fontSize: '14px' }}>
            Already have an account?
          </Text>
        </Divider>

        <div style={{ textAlign: 'center' }}>
          <Link to="/login">
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
              Sign In
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}