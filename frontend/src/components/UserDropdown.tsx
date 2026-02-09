import React, { useState, useEffect } from 'react';
import { User, LogOut } from 'lucide-react';
import { api } from '../api';
import { fullLogout } from '../lib/logout';
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

export default function UserDropdown() {
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
    fullLogout();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="h-9 w-9 rounded-full flex items-center justify-content cursor-pointer border-0 outline-none focus:ring-2 focus:ring-emerald-400/40 transition-all hover:scale-105"
          style={{ background: 'linear-gradient(135deg, #3b82f6, #34d399)' }}
        >
          <Avatar className="h-9 w-9">
            <AvatarFallback
              className="text-sm font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #34d399)' }}
            >
              {userInfo?.username?.[0]?.toUpperCase() || <User className="h-4 w-4" />}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-1 py-1">
            <p className="text-sm font-semibold text-foreground">
              {userInfo?.username || 'User'}
            </p>
            <p className="text-xs text-muted-foreground">
              {userInfo?.email}
            </p>
          </div>
        </DropdownMenuLabel>

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
