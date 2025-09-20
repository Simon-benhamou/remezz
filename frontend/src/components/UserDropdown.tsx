import React, { useState, useEffect } from 'react';
import { Avatar, Dropdown, Space, Typography, Button, Modal, Badge } from 'antd';
import { UserOutlined, SettingOutlined, LogoutOutlined, KeyOutlined, EditOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { clearApiKey } from '../api';
import { useNavigate } from 'react-router-dom';
import UserSettingsModal from './UserSettingsModal';
import EditProfileModal from './EditProfileModal';
import { api } from '../api';

const { Text } = Typography;

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt?: string;
}

export default function UserDropdown() {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadUserInfo();
  }, []);

  const loadUserInfo = async () => {
    try {
      const result = await api.client.get('/api/auth/me');
      setUserInfo(result.data.user);
    } catch (error) {
      console.error('Failed to load user info:', error);
    }
  };

  const handleLogout = () => {
    clearApiKey();
    navigate('/login');
  };

  const items: MenuProps['items'] = [
    {
      key: 'profile',
      label: (
        <div style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: '#1f2937' }}>
            {userInfo?.username || 'User'}
          </div>
          <div style={{ fontSize: '12px', color: '#6b7280' }}>
            {userInfo?.email}
          </div>
          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '2px' }}>
            {userInfo?.role === 'admin' ? '👑 Administrator' : '📈 Trader'}
          </div>
        </div>
      ),
      disabled: true,
    },
    {
      type: 'divider',
    },
    {
      key: 'settings',
      label: 'Settings & API Keys',
      icon: <SettingOutlined />,
      onClick: () => setSettingsVisible(true),
    },
    {
      key: 'profile-edit',
      label: 'Edit Profile',
      icon: <EditOutlined />,
      onClick: () => setEditProfileVisible(true),
    },
    {
      type: 'divider',
    },
    {
      key: 'logout',
      label: 'Sign out',
      icon: <LogoutOutlined />,
      onClick: handleLogout,
      danger: true,
    },
  ];

  const getAvatarColor = (username: string) => {
    const colors = ['#1890ff', '#52c41a', '#fa8c16', '#eb2f96', '#13c2c2', '#722ed1'];
    const index = username.charCodeAt(0) % colors.length;
    return colors[index];
  };

  return (
    <>
      <Dropdown 
        menu={{ items }} 
        placement="bottomRight"
        trigger={['click']}
      >
        <Button 
          type="text" 
          style={{ 
            height: '40px',
            padding: '0 8px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            borderRadius: '8px',
            border: '1px solid transparent',
            transition: 'all 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#f9fafb';
            e.currentTarget.style.borderColor = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        >
          <Space>
            <Avatar 
              size={32}
              style={{ 
                backgroundColor: getAvatarColor(userInfo?.username || 'U'),
                fontSize: '14px',
                fontWeight: '600'
              }}
              icon={<UserOutlined />}
            >
              {userInfo?.username?.[0]?.toUpperCase()}
            </Avatar>
            <div style={{ textAlign: 'left', lineHeight: '1.2' }}>
              <div style={{ 
                fontSize: '13px', 
                fontWeight: '600', 
                color: '#1f2937',
                maxWidth: '100px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {userInfo?.username || 'Loading...'}
              </div>
              <div style={{ 
                fontSize: '11px', 
                color: '#6b7280',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}>
                {userInfo?.role === 'admin' && '👑'}
                {userInfo?.role === 'trader' && '📈'}
                {userInfo?.role || 'User'}
              </div>
            </div>
          </Space>
        </Button>
      </Dropdown>

      <UserSettingsModal
        visible={settingsVisible}
        onClose={() => setSettingsVisible(false)}
        userInfo={userInfo}
        onUserUpdate={loadUserInfo}
      />

      <EditProfileModal
        visible={editProfileVisible}
        onClose={() => setEditProfileVisible(false)}
        userInfo={userInfo}
        onUserUpdate={loadUserInfo}
      />
    </>
  );
}