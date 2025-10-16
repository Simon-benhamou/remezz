import React, { useState } from 'react';
import { Modal, Form, Input, Button, Space, message, Alert, Typography } from 'antd';
import { UserOutlined, MailOutlined, LockOutlined } from '../icons';
import { api } from '../api';

const { Title, Text } = Typography;

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt?: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  userInfo: UserInfo | null;
  onUserUpdate: () => void;
}

export default function EditProfileModal({ visible, onClose, userInfo, onUserUpdate }: Props) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [passwordForm] = Form.useForm();
  const [changingPassword, setChangingPassword] = useState(false);

  const handleUpdateProfile = async (values: any) => {
    setLoading(true);
    try {
      await api.client.put('/api/auth/profile', {
        email: values.email
      });
      message.success('Profile updated successfully');
      onUserUpdate();
      onClose();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = async (values: any) => {
    setChangingPassword(true);
    try {
      await api.client.put('/api/auth/password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword
      });
      message.success('Password changed successfully');
      passwordForm.resetFields();
    } catch (error: any) {
      message.error(error?.response?.data?.error || 'Failed to change password');
    } finally {
      setChangingPassword(false);
    }
  };

  React.useEffect(() => {
    if (visible && userInfo) {
      form.setFieldsValue({
        username: userInfo.username,
        email: userInfo.email
      });
    }
  }, [visible, userInfo, form]);

  return (
    <Modal
      title="Edit Profile"
      open={visible}
      onCancel={onClose}
      footer={null}
      width={500}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div>
          <Title level={4}>Profile Information</Title>
          <Text type="secondary">
            Update your account details. Your username cannot be changed for security reasons.
          </Text>
        </div>

        <Form
          form={form}
          layout="vertical"
          onFinish={handleUpdateProfile}
        >
          <Form.Item
            label="Username"
            name="username"
            help="Username cannot be changed"
          >
            <Input 
              prefix={<UserOutlined style={{ color: '#667eea' }} />}
              disabled 
              style={{ 
                backgroundColor: '#f5f5f5',
                borderColor: '#d9d9d9'
              }}
            />
          </Form.Item>

          <Form.Item
            label="Email"
            name="email"
            rules={[
              { required: true, message: 'Please enter your email' },
              { type: 'email', message: 'Please enter a valid email address' }
            ]}
          >
            <Input 
              prefix={<MailOutlined style={{ color: '#667eea' }} />}
              placeholder="Enter your email"
            />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              style={{
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none'
              }}
            >
              Update Profile
            </Button>
          </Form.Item>
        </Form>

        <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '24px' }}>
          <Title level={4}>Change Password</Title>
          <Text type="secondary">
            Update your password to keep your account secure.
          </Text>
          
          <Form
            form={passwordForm}
            layout="vertical"
            onFinish={handleChangePassword}
            style={{ marginTop: '16px' }}
          >
            <Form.Item
              label="Current Password"
              name="currentPassword"
              rules={[{ required: true, message: 'Please enter your current password' }]}
            >
              <Input.Password 
                prefix={<LockOutlined style={{ color: '#667eea' }} />}
                placeholder="Enter current password"
              />
            </Form.Item>

            <Form.Item
              label="New Password"
              name="newPassword"
              rules={[
                { required: true, message: 'Please enter a new password' },
                { min: 6, message: 'Password must be at least 6 characters' }
              ]}
            >
              <Input.Password 
                prefix={<LockOutlined style={{ color: '#667eea' }} />}
                placeholder="Enter new password"
              />
            </Form.Item>

            <Form.Item
              label="Confirm New Password"
              name="confirmNewPassword"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: 'Please confirm your new password' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value) {
                      return Promise.resolve();
                    }
                    return Promise.reject(new Error('Passwords do not match!'));
                  },
                }),
              ]}
            >
              <Input.Password 
                prefix={<LockOutlined style={{ color: '#667eea' }} />}
                placeholder="Confirm new password"
              />
            </Form.Item>

            <Form.Item>
              <Button
                type="default"
                htmlType="submit"
                loading={changingPassword}
                style={{
                  borderColor: '#667eea',
                  color: '#667eea'
                }}
              >
                Change Password
              </Button>
            </Form.Item>
          </Form>
        </div>

        <Alert
          message="Account Security"
          description="For security reasons, changing sensitive account information may require re-authentication. Contact support if you need assistance."
          type="info"
          showIcon
        />
      </Space>
    </Modal>
  );
}
