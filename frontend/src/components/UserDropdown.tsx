import React, { useState, useEffect } from 'react';
import { Avatar, Dropdown, Space, Typography, Button, Modal, Badge } from 'antd';
import { UserOutlined, SettingOutlined, LogoutOutlined, EditOutlined } from '@ant-design/icons';
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
    try {
      // Nettoyer toutes les données stockées
      clearApiKey();
      
      // Nettoyer le localStorage pour tout l'état de l'app
      const keysToKeep = ['appMode']; // Garder le mode de trading
      const allKeys = Object.keys(localStorage);
      allKeys.forEach(key => {
        if (!keysToKeep.includes(key)) {
          localStorage.removeItem(key);
        }
      });
      
      // Force une redirection complète pour assurer un état propre
      window.location.href = '/login';
    } catch (error) {
      console.error('Logout error:', error);
      // Fallback en cas d'erreur
      window.location.href = '/login';
    }
  };

  const items: MenuProps['items'] = [
    {
      key: 'profile',
      label: (
        <div style={{ padding: '8px 0', borderBottom: '1px solid rgba(148, 163, 184, 0.18)' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', color: '#e2e8f0' }}>
            {userInfo?.username || 'User'}
          </div>
          <div style={{ fontSize: '12px', color: 'rgba(148, 163, 184, 0.78)' }}>
            {userInfo?.email}
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(148, 163, 184, 0.58)', marginTop: '2px' }}>
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
            height: '44px',
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            borderRadius: '12px',
            border: '1px solid rgba(96, 165, 250, 0.25)',
            transition: 'all 0.2s ease',
            background: 'rgba(15, 23, 42, 0.6)',
            color: '#e2e8f0',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(37, 99, 235, 0.18)';
            e.currentTarget.style.borderColor = 'rgba(96, 165, 250, 0.55)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(15, 23, 42, 0.6)';
            e.currentTarget.style.borderColor = 'rgba(96, 165, 250, 0.25)';
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
                color: '#e2e8f0',
                maxWidth: '120px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {userInfo?.username || 'Loading...'}
              </div>
              <div style={{
                fontSize: '11px',
                color: 'rgba(148, 163, 184, 0.78)',
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