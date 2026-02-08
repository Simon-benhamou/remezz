import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Settings, Pencil, LogOut } from 'lucide-react';
import { clearApiKey, api } from '../api';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

interface UserInfo {
  id: string;
  username: string;
  email: string;
  role: string;
  createdAt?: string;
}

const AVATAR_COLORS = ['#1890ff', '#52c41a', '#fa8c16', '#eb2f96', '#13c2c2', '#722ed1'];

function getAvatarColor(username: string) {
  const index = username.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

export default function UserDropdown() {
  const navigate = useNavigate();
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

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
      clearApiKey();

      const keysToKeep = ['appMode'];
      const allKeys = Object.keys(localStorage);
      allKeys.forEach((key) => {
        if (!keysToKeep.includes(key)) {
          localStorage.removeItem(key);
        }
      });

      window.location.href = '/login';
    } catch (error) {
      console.error('Logout error:', error);
      window.location.href = '/login';
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 px-3 flex items-center gap-2.5 rounded-xl border border-cyan-500/25 bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-blue-600/20 hover:border-cyan-500/55 transition-all"
        >
          <Avatar className="h-8 w-8">
            <AvatarFallback
              className="text-sm font-semibold text-white"
              style={{ backgroundColor: getAvatarColor(userInfo?.username || 'U') }}
            >
              {userInfo?.username?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
          <div className="text-left leading-tight">
            <div className="text-[13px] font-semibold text-[var(--text-primary)] max-w-[120px] truncate">
              {userInfo?.username || 'Loading...'}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
              {userInfo?.role || 'User'}
            </div>
          </div>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1 py-1">
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              {userInfo?.username || 'User'}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {userInfo?.email}
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              {userInfo?.role === 'admin' ? 'Administrator' : 'Trader'}
            </p>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => navigate('/settings')}
        >
          <Settings className="mr-2 h-4 w-4" />
          Settings & API Keys
        </DropdownMenuItem>

        <DropdownMenuItem
          className="cursor-pointer"
          onClick={() => navigate('/settings')}
        >
          <Pencil className="mr-2 h-4 w-4" />
          Edit Profile
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onClick={handleLogout}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
