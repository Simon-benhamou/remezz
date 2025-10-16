import React from 'react';
import { Card, Form, Input, Button, Typography, message, Divider, Space } from 'antd';
import { UserOutlined, LockOutlined, GoogleOutlined, GithubOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';

const { Title, Text } = Typography;

const HERO_METRICS = [
  { label: 'Active Users', value: '128' },
  { label: 'All Agents', value: '45,692' },
  { label: 'Average Win Rate', value: '74.2%' },
  { label: '24h Executions', value: '8,120' },
];

export default function LoginPage() {
  const [form] = Form.useForm();
  const navigate = useNavigate();
  const { signIn, isLoading, isAuthenticated } = useAuth();

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/operations', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onFinish = async (values: any) => {
    try {
      const result = await api.auth.login(values.username, values.password);
      if (result?.token) {
        await signIn(result.token);
        message.success(`Welcome back, ${result.user.username}!`);
        navigate('/operations', { replace: true });
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Login failed');
    }
  };

  return (
    <div className='auth-layout'>
      <div className='auth-panel'>
        <div className='auth-panel__badge'>⚡</div>
        <h1 className='auth-panel__title'>QuantAI</h1>
        <p className='auth-panel__subtitle'>
          Trade smarter with AI agents that monitor markets 24/7, react instantly to volatility, and keep risk under control.
        </p>
        <div className='auth-panel__metrics'>
          {HERO_METRICS.map((metric) => (
            <div key={metric.label} className='auth-panel__metric'>
              <span className='auth-panel__metric-label'>{metric.label}</span>
              <span className='auth-panel__metric-value'>{metric.value}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 48, fontSize: 12, color: 'rgba(226, 232, 240, 0.65)' }}>
          Advanced AI trading · Real-time analytics · 24/7 autonomous execution
        </div>
      </div>

      <div className='auth-form-wrapper'>
        <Card className='auth-form-card' bordered={false}>
          <div style={{ marginBottom: 32 }}>
            <Title level={2} style={{ color: '#e2e8f0', marginBottom: 8 }}>
              Welcome back
            </Title>
            <Text type='secondary' style={{ color: 'rgba(148, 163, 184, 0.75)' }}>
              Sign in to your account to continue
            </Text>
          </div>

          <Form
            form={form}
            name='login'
            onFinish={onFinish}
            layout='vertical'
            size='large'
            requiredMark={false}
          >
            <Form.Item
              name='username'
              label='Email'
              rules={[{ required: true, message: 'Please enter your email' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#60a5fa' }} />}
                placeholder='name@example.com'
                autoComplete='username'
              />
            </Form.Item>

            <Form.Item
              name='password'
              label='Password'
              rules={[{ required: true, message: 'Please enter your password' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#60a5fa' }} />}
                placeholder='Enter your password'
                autoComplete='current-password'
              />
            </Form.Item>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <Link to='/register'>Need an account?</Link>
              <Link to='/reset-password'>Forgot password?</Link>
            </div>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type='primary'
                htmlType='submit'
                loading={isLoading}
                block
              >
                Sign In
              </Button>
            </Form.Item>
          </Form>

          <Divider plain style={{ borderColor: 'rgba(148, 163, 184, 0.25)', color: 'rgba(148, 163, 184, 0.6)' }}>
            Or continue with
          </Divider>

          <Space direction='vertical' size={12} style={{ width: '100%' }}>
            <Button icon={<GoogleOutlined />} block disabled>
              Google (coming soon)
            </Button>
            <Button icon={<GithubOutlined />} block disabled>
              GitHub (coming soon)
            </Button>
          </Space>

          <div style={{ marginTop: 24, fontSize: 12, color: 'rgba(148, 163, 184, 0.6)' }}>
            By continuing, you agree to the{' '}
            <a href='https://quantai.ai/terms' target='_blank' rel='noreferrer'>Terms of Service</a> and{' '}
            <a href='https://quantai.ai/privacy' target='_blank' rel='noreferrer'>Privacy Policy</a>.
          </div>
        </Card>
      </div>
    </div>
  );
}
