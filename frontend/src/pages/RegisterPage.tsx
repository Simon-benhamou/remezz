import React from 'react';
import { Alert, Button, Card, Divider, Form, Input, Space, Typography, message } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import {
  GithubOutlined,
  GoogleOutlined,
  KeyOutlined,
  LockOutlined,
  MailOutlined,
  UserOutlined,
} from '../icons';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { AUTH_FEATURES, HERO_METRICS } from './authContent';

const { Title, Text } = Typography;

type RegisterFormValues = {
  registrationCode: string;
  username: string;
  email: string;
  password: string;
  confirmPassword: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  missing_required_fields: 'Please fill in all required fields.',
  invalid_registration_code: 'Invalid registration code. Contact your administrator for access.',
  username_must_be_3_20_chars: 'Username must be between 3 and 20 characters long.',
  password_must_be_at_least_6_chars: 'Password must be at least 6 characters.',
  invalid_email_format: 'Enter a valid email address.',
  username_already_exists: 'This username is already taken.',
  email_already_exists: 'This email is already registered.',
  server_error: 'Server error, please try again later.',
};

export default function RegisterPage() {
  const [form] = Form.useForm<RegisterFormValues>();
  const navigate = useNavigate();
  const { signIn, isLoading, isAuthenticated } = useAuth();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/operations', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onFinish = async (values: RegisterFormValues) => {
    setIsSubmitting(true);
    try {
      const response = await api.client.post('/api/auth/register', {
        username: values.username,
        email: values.email,
        password: values.password,
        registrationCode: values.registrationCode,
      });

      const { token, user } = response.data;

      if (!token) {
        throw new Error('Invalid response from server');
      }

      await signIn(token);
      message.success(`Welcome aboard, ${user?.username || values.username}!`);
      navigate('/operations', { replace: true });
    } catch (error: any) {
      const errorCode: string | undefined = error?.response?.data?.error;
      const fallbackMessage = error?.message || 'Registration failed';
      message.error((errorCode && ERROR_MESSAGES[errorCode]) || fallbackMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className='auth-layout'>
      <div className='auth-panel'>
        <img src="/remezz-logo.svg" alt="Remezz" style={{ height: 36, marginBottom: 16 }} />
        <h1 className='auth-panel__title'>Remezz</h1>
        <p className='auth-panel__subtitle'>
          Build resilient algorithmic strategies with AI copilots that supervise risk, analyse market regimes, and execute with precision.
        </p>
        <div className='auth-panel__metrics'>
          {HERO_METRICS.map((metric) => (
            <div key={metric.label} className='auth-panel__metric'>
              <span className='auth-panel__metric-label'>{metric.label}</span>
              <span className='auth-panel__metric-value'>{metric.value}</span>
            </div>
          ))}
        </div>
        <div className='auth-panel__features'>
          {AUTH_FEATURES.map((feature) => (
            <div key={feature} className='auth-panel__feature'>
              <span className='auth-panel__feature-icon'>
                <span role='img' aria-label='check'>
                  ✓
                </span>
              </span>
              <span className='auth-panel__feature-label'>{feature}</span>
            </div>
          ))}
        </div>
        <div className='auth-panel__footer'>
          Trusted by professional quant desks and high-frequency trading teams worldwide.
        </div>
      </div>

      <div className='auth-form-wrapper'>
        <Card className='auth-form-card' bordered={false}>
          <div style={{ marginBottom: 32 }}>
            <Title level={2} style={{ color: 'var(--text-primary)', marginBottom: 8 }}>
              Create your account
            </Title>
            <Text type='secondary' style={{ color: 'rgba(148, 163, 184, 0.75)' }}>
              Join the Remezz platform in minutes
            </Text>
          </div>

          <Form<RegisterFormValues>
            form={form}
            name='register'
            layout='vertical'
            size='large'
            requiredMark={false}
            onFinish={onFinish}
          >
            <Form.Item
              name='registrationCode'
              label='Registration Code'
              rules={[
                { required: true, message: 'Registration code is required' },
                { len: 9, message: 'Registration code must be exactly 9 characters' },
              ]}
            >
              <Input
                prefix={<KeyOutlined style={{ color: '#06b6d4' }} />}
                placeholder='Enter your registration code'
                autoComplete='one-time-code'
              />
            </Form.Item>

            <Form.Item
              name='username'
              label='Username'
              rules={[
                { required: true, message: 'Please choose a username' },
                { min: 3, message: 'Username must be at least 3 characters' },
                { max: 20, message: 'Username must be less than 20 characters' },
                {
                  pattern: /^[a-zA-Z0-9_]+$/,
                  message: 'Username can only contain letters, numbers, and underscores',
                },
              ]}
            >
              <Input
                prefix={<UserOutlined style={{ color: '#06b6d4' }} />}
                placeholder='Choose a username'
                autoComplete='username'
              />
            </Form.Item>

            <Form.Item
              name='email'
              label='Email'
              rules={[
                { required: true, message: 'Please enter your email' },
                { type: 'email', message: 'Enter a valid email address' },
              ]}
            >
              <Input
                prefix={<MailOutlined style={{ color: '#06b6d4' }} />}
                placeholder='name@example.com'
                autoComplete='email'
              />
            </Form.Item>

            <Form.Item
              name='password'
              label='Password'
              rules={[
                { required: true, message: 'Please create a password' },
                { min: 6, message: 'Password must be at least 6 characters' },
              ]}
              hasFeedback
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#06b6d4' }} />}
                placeholder='Create a strong password'
                autoComplete='new-password'
              />
            </Form.Item>

            <Form.Item
              name='confirmPassword'
              label='Confirm Password'
              dependencies={['password']}
              hasFeedback
              rules={[
                { required: true, message: 'Please confirm your password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('Passwords do not match'));
                  },
                }),
              ]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#06b6d4' }} />}
                placeholder='Re-enter your password'
                autoComplete='new-password'
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0 }}>
              <Button
                type='primary'
                htmlType='submit'
                loading={isSubmitting || isLoading}
                block
              >
                Create Account
              </Button>
            </Form.Item>
          </Form>

          <Alert
            type='warning'
            showIcon={false}
            style={{
              marginTop: 24,
              background: 'rgba(250, 204, 21, 0.12)',
              borderColor: 'rgba(234, 179, 8, 0.4)',
              color: 'rgba(250, 204, 21, 0.95)',
            }}
            message={
              <Text style={{ color: 'rgba(226, 232, 240, 0.85)' }}>
                A valid registration code is required to onboard new desks. Contact your Remezz administrator if you need access.
              </Text>
            }
          />

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
            <a href='https://remezz.io/terms' target='_blank' rel='noreferrer'>Terms of Service</a> and{' '}
            <a href='https://remezz.io/privacy' target='_blank' rel='noreferrer'>Privacy Policy</a>.
          </div>

          <Divider style={{ borderColor: 'rgba(148, 163, 184, 0.25)' }} />

          <div style={{ textAlign: 'center', color: 'rgba(148, 163, 184, 0.75)' }}>
            Already have an account? <Link to='/login'>Sign in</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

