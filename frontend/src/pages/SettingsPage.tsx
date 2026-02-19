import React, { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  User,
  Key,
  Settings,
  Trash2,
  Shield,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Mail,
  Lock,
  Info,
  TrendingUp,
  Target,
  ShieldCheck,
  Zap,
  BarChart3,
  Clock,
  Send,
  MessageCircle,
  CheckCircle2,
  DollarSign,
  Activity,
  Wallet,
  Power,
  AlertTriangle,
} from 'lucide-react';

import { api } from '@/api';
import { useAuth } from '@/hooks/useAuth';
import { useAppStore } from '@/store';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  email: z
    .string()
    .min(1, 'Please enter your email')
    .email('Please enter a valid email address'),
});

type ProfileFormValues = z.infer<typeof profileSchema>;

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Please enter your current password'),
    newPassword: z.string().min(6, 'Password must be at least 6 characters'),
    confirmNewPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Passwords do not match',
    path: ['confirmNewPassword'],
  });

type PasswordFormValues = z.infer<typeof passwordSchema>;

const apiKeySchema = z.object({
  exchange: z.string().min(1, 'Please select an exchange'),
  keyName: z.string().optional(),
  apiKey: z.string().min(1, 'Please enter your API key'),
  apiSecret: z.string().min(1, 'Please enter your API secret'),
});

type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

// ---------------------------------------------------------------------------
// Profile Tab
// ---------------------------------------------------------------------------

function ProfileTab({ userInfo, onUserUpdate }: { userInfo: UserInfo | null; onUserUpdate: () => void }) {
  const [profileLoading, setProfileLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  const profileForm = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema as any),
    defaultValues: { email: userInfo?.email || '' },
  });

  const passwordForm = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema as any),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmNewPassword: '',
    },
  });

  useEffect(() => {
    if (userInfo?.email) {
      profileForm.reset({ email: userInfo.email });
    }
  }, [userInfo, profileForm]);

  const handleUpdateProfile = async (values: ProfileFormValues) => {
    setProfileLoading(true);
    try {
      await api.client.put('/api/auth/profile', { email: values.email });
      toast.success('Profile updated successfully');
      onUserUpdate();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to update profile');
    } finally {
      setProfileLoading(false);
    }
  };

  const handleChangePassword = async (values: PasswordFormValues) => {
    setPasswordLoading(true);
    try {
      await api.client.put('/api/auth/password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      toast.success('Password changed successfully');
      passwordForm.reset();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* User info (read only) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile Information
          </CardTitle>
          <CardDescription>
            Your account details. Username and role cannot be changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider">Username</Label>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/50 px-3 text-sm">
                {userInfo?.username || '-'}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider">Email</Label>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/50 px-3 text-sm">
                {userInfo?.email || '-'}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider">Role</Label>
              <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-muted/50 px-3 text-sm">
                <Badge variant="outline" className="capitalize">
                  {userInfo?.role === 'admin' ? 'Administrator' : userInfo?.role || 'User'}
                </Badge>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit email */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Update Email
          </CardTitle>
          <CardDescription>
            Change the email address associated with your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...profileForm}>
            <form onSubmit={profileForm.handleSubmit(handleUpdateProfile)} className="space-y-4">
              <FormField
                control={profileForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input placeholder="Enter your email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={profileLoading}>
                {profileLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Update Profile
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Change password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update your password to keep your account secure.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...passwordForm}>
            <form onSubmit={passwordForm.handleSubmit(handleChangePassword)} className="space-y-4">
              <FormField
                control={passwordForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Enter current password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Enter new password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="confirmNewPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm New Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Confirm new password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" variant="outline" disabled={passwordLoading}>
                {passwordLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Change Password
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Alert>
        <Shield className="h-4 w-4" />
        <AlertDescription>
          For security reasons, changing sensitive account information may require re-authentication.
          Contact support if you need assistance.
        </AlertDescription>
      </Alert>
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Keys Tab
// ---------------------------------------------------------------------------

function ApiKeysTab() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({});
  const [addLoading, setAddLoading] = useState(false);

  const apiKeyForm = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema as any),
    defaultValues: { exchange: '', keyName: '', apiKey: '', apiSecret: '' },
  });

  const loadApiKeys = useCallback(async () => {
    try {
      const result = await api.client.get('/api/user/api-keys');
      setApiKeys(result.data.apiKeys || []);
    } catch (error) {
      console.error('Failed to load API keys:', error);
    }
  }, []);

  useEffect(() => {
    loadApiKeys();
  }, [loadApiKeys]);

  const handleAddApiKey = async (values: ApiKeyFormValues) => {
    setAddLoading(true);
    try {
      await api.client.post('/api/user/api-keys', values);
      toast.success('API Key added successfully');
      apiKeyForm.reset();
      loadApiKeys();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to add API key');
    } finally {
      setAddLoading(false);
    }
  };

  const handleDeleteApiKey = async (keyId: string) => {
    try {
      await api.client.delete(`/api/user/api-keys/${keyId}`);
      toast.success('API Key deleted successfully');
      loadApiKeys();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to delete API key');
    }
  };

  const handleToggleApiKey = async (keyId: string) => {
    try {
      await api.client.patch(`/api/user/api-keys/${keyId}/toggle`);
      toast.success('API key status updated');
      loadApiKeys();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to toggle API key');
    }
  };

  const toggleShowApiKey = (keyId: string) => {
    setShowApiKeys((prev) => ({ ...prev, [keyId]: !prev[keyId] }));
  };

  const maskedApiKey = (key: string) => {
    if (key.length <= 8) return '*'.repeat(key.length);
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
  };

  return (
    <div className="space-y-6">
      {/* Info alerts */}
      <Alert>
        <Shield className="h-4 w-4" />
        <AlertDescription>
          Your API keys are encrypted and stored securely in the database. The system will
          automatically use your configured keys for trading operations instead of environment
          variables.
        </AlertDescription>
      </Alert>

      <Alert className="border-amber-500/30 bg-amber-500/5">
        <Shield className="h-4 w-4 text-amber-500" />
        <AlertDescription>
          <span className="font-medium">Server IP Whitelist Required</span>
          <br />
          Add your server IP to your exchange API whitelist. Current host:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-semibold text-cyan-400">
            {window.location.hostname}
          </code>
        </AlertDescription>
      </Alert>

      <Alert className="border-amber-500/30 bg-amber-500/5">
        <Shield className="h-4 w-4 text-amber-500" />
        <AlertDescription>
          Never share your API keys with anyone. Use read-only or trading permissions only.
        </AlertDescription>
      </Alert>

      {/* Add new key form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Add New API Key
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...apiKeyForm}>
            <form onSubmit={apiKeyForm.handleSubmit(handleAddApiKey)} className="space-y-4">
              <FormField
                control={apiKeyForm.control}
                name="exchange"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Exchange</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select exchange" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="crypto.com">Crypto.com</SelectItem>
                        <SelectItem value="binance">Binance</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={apiKeyForm.control}
                name="keyName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Key Name (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., Main Trading Account" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={apiKeyForm.control}
                name="apiKey"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Key</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Enter your API key" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={apiKeyForm.control}
                name="apiSecret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>API Secret</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="Enter your API secret" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Alert className="border-emerald-500/30 bg-emerald-500/5">
                <AlertDescription className="text-xs">
                  <span className="font-medium">Whitelist Configuration</span>
                  <br />
                  Before using your API key, add your server IP to your exchange whitelist.
                  Current host:{' '}
                  <code className="font-semibold text-cyan-400">{window.location.hostname}</code>
                  <br />
                  <span className="text-muted-foreground">
                    Go to your exchange &rarr; API Management &rarr; Edit your API &rarr; IP Whitelist
                  </span>
                </AlertDescription>
              </Alert>

              <Button type="submit" disabled={addLoading}>
                {addLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Plus className="mr-2 h-4 w-4" />
                Add API Key
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Existing keys */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Your API Keys
            {apiKeys.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {apiKeys.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {apiKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Key className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <p className="text-muted-foreground">No API keys configured</p>
              <p className="text-sm text-muted-foreground/60">
                Add your first exchange API key above
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {apiKeys.map((key) => (
                <div
                  key={key.id}
                  className="rounded-lg border border-border bg-muted/20 p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline">{key.exchange}</Badge>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={key.isActive}
                          onCheckedChange={() => handleToggleApiKey(key.id)}
                        />
                        <span className="text-xs text-muted-foreground">
                          {key.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Added {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => toggleShowApiKey(key.id)}
                      >
                        {showApiKeys[key.id] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </Button>
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Delete API Key</DialogTitle>
                            <DialogDescription>
                              Are you sure you want to delete this API key? This action cannot be
                              undone.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <Button variant="outline" onClick={() => {}}>
                              Cancel
                            </Button>
                            <Button
                              variant="destructive"
                              onClick={() => handleDeleteApiKey(key.id)}
                            >
                              Delete
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </div>
                  {key.keyName && (
                    <p className="mt-2 text-sm font-medium">{key.keyName}</p>
                  )}
                  <div className="mt-2">
                    <code className="text-xs text-muted-foreground">
                      {showApiKeys[key.id] ? key.apiKey : maskedApiKey(key.apiKey)}
                    </code>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preferences Tab
// ---------------------------------------------------------------------------

function PreferencesTab() {
  const { themeMode, toggleTheme } = useAppStore();
  const [defaultTradingMode, setDefaultTradingMode] = useState('paper');
  const [riskLevel, setRiskLevel] = useState('moderate');
  const [tradeAlerts, setTradeAlerts] = useState(true);
  const [dailyReports, setDailyReports] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(false);

  // Telegram Chat ID
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramSaved, setTelegramSaved] = useState('');
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramTestOk, setTelegramTestOk] = useState(false);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectedChats, setDetectedChats] = useState<{ chatId: string; firstName: string; username?: string }[]>([]);

  // Load saved Telegram Chat ID + bot info on mount
  useEffect(() => {
    (async () => {
      try {
        const [settingsRes, botRes] = await Promise.all([
          api.client.get('/api/user/settings'),
          api.client.get('/api/user/telegram-bot'),
        ]);
        const settings: { key: string; value: string }[] = settingsRes.data.settings || [];
        const tg = settings.find((s) => s.key === 'telegramChatId');
        if (tg?.value) {
          setTelegramChatId(tg.value);
          setTelegramSaved(tg.value);
        }
        if (botRes.data.botUsername) {
          setBotUsername(botRes.data.botUsername);
        }
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleSaveTelegramChatId = async () => {
    setTelegramSaving(true);
    setTelegramTestOk(false);
    try {
      await api.client.put('/api/user/settings/telegramChatId', {
        value: telegramChatId.trim(),
        category: 'notifications',
      });
      setTelegramSaved(telegramChatId.trim());
      toast.success('Telegram Chat ID saved');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to save');
    } finally {
      setTelegramSaving(false);
    }
  };

  const handleTestTelegram = async () => {
    setTelegramTesting(true);
    setTelegramTestOk(false);
    try {
      const res = await api.client.post('/api/user/telegram-test');
      if (res.data.success) {
        setTelegramTestOk(true);
        toast.success('Test notification sent! Check your Telegram.');
      } else {
        toast.error(res.data.error || 'Test failed');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Test failed');
    } finally {
      setTelegramTesting(false);
    }
  };

  const handleDetectChatId = async () => {
    setDetecting(true);
    setDetectedChats([]);
    try {
      const res = await api.client.get('/api/user/telegram-detect');
      const chats = res.data.chatIds || [];
      if (chats.length === 0) {
        toast.error(
          botUsername
            ? `No messages found. Send /start to @${botUsername} on Telegram first.`
            : 'No messages found. Send /start to the bot on Telegram first.'
        );
      } else {
        setDetectedChats(chats);
        // Auto-fill if only one result
        if (chats.length === 1) {
          setTelegramChatId(chats[0].chatId);
          setDetectedChats([]);
          toast.success(`Chat ID detected: ${chats[0].firstName}`);
        }
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Detection failed');
    } finally {
      setDetecting(false);
    }
  };

  const telegramDirty = telegramChatId.trim() !== telegramSaved;

  return (
    <div className="space-y-6">
      {/* Telegram Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            Telegram Notifications
          </CardTitle>
          <CardDescription>
            Receive real-time alerts on your phone when positions are opened or closed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Step 1: Instructions */}
          <Alert className="border-blue-500/30 bg-blue-500/5">
            <MessageCircle className="h-4 w-4 text-blue-500" />
            <AlertDescription className="text-xs">
              <span className="font-medium">Setup in 3 steps:</span>
              <ol className="mt-1 list-inside list-decimal space-y-0.5">
                <li>
                  Open Telegram and send <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">/start</code> to{' '}
                  {botUsername ? (
                    <a
                      href={`https://t.me/${botUsername}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-blue-400 hover:underline"
                    >
                      @{botUsername}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">the bot</span>
                  )}
                </li>
                <li>Click <span className="font-semibold">Detect my Chat ID</span> below</li>
                <li>Save and test</li>
              </ol>
            </AlertDescription>
          </Alert>

          {/* Step 2: Detect + Input */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Telegram Chat ID</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="e.g. 123456789"
                value={telegramChatId}
                onChange={(e) => {
                  setTelegramChatId(e.target.value);
                  setTelegramTestOk(false);
                }}
                className="max-w-[200px] font-mono"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={detecting}
                onClick={handleDetectChatId}
              >
                {detecting ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : (
                  <MessageCircle className="mr-2 h-3 w-3" />
                )}
                Detect
              </Button>
              <Button
                size="sm"
                disabled={telegramSaving || !telegramChatId.trim() || !telegramDirty}
                onClick={handleSaveTelegramChatId}
              >
                {telegramSaving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={telegramTesting || !telegramSaved}
                onClick={handleTestTelegram}
              >
                {telegramTesting ? (
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                ) : telegramTestOk ? (
                  <CheckCircle2 className="mr-2 h-3 w-3 text-emerald-500" />
                ) : (
                  <Send className="mr-2 h-3 w-3" />
                )}
                Test
              </Button>
            </div>

            {/* Detected chat IDs (if multiple) */}
            {detectedChats.length > 1 && (
              <div className="space-y-1 pt-1">
                <p className="text-xs font-medium text-muted-foreground">Select your account:</p>
                <div className="flex flex-wrap gap-2">
                  {detectedChats.map((chat) => (
                    <Button
                      key={chat.chatId}
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => {
                        setTelegramChatId(chat.chatId);
                        setDetectedChats([]);
                      }}
                    >
                      {chat.firstName}
                      {chat.username && (
                        <span className="ml-1 text-muted-foreground">@{chat.username}</span>
                      )}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {telegramSaved && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                <span className="text-xs text-emerald-500">
                  Connected — Chat ID: <code className="font-mono">{telegramSaved}</code>
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Preferences
          </CardTitle>
          <CardDescription>
            Configure your display and notification settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Appearance */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Appearance</Label>
            <div className="flex items-center gap-3">
              <Switch
                checked={themeMode === 'dark'}
                onCheckedChange={toggleTheme}
              />
              <span className="text-sm text-muted-foreground">
                {themeMode === 'dark' ? 'Dark mode' : 'Light mode'}
              </span>
            </div>
          </div>

          <Separator />

          {/* Default Trading Mode */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Default Trading Mode</Label>
            <Select value={defaultTradingMode} onValueChange={setDefaultTradingMode}>
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="paper">Paper Trading</SelectItem>
                <SelectItem value="live">Live Trading</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Risk Level */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Risk Level</Label>
            <Select value={riskLevel} onValueChange={setRiskLevel}>
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Notifications */}
          <div className="space-y-4">
            <Label className="text-sm font-medium">Notifications</Label>
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Switch checked={tradeAlerts} onCheckedChange={setTradeAlerts} />
                <span className="text-sm">Trade alerts</span>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={dailyReports} onCheckedChange={setDailyReports} />
                <span className="text-sm">Daily reports</span>
              </div>
              <div className="flex items-center gap-3">
                <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
                <span className="text-sm">Email notifications</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polymarket Tab
// ---------------------------------------------------------------------------

function PolymarketTab() {
  // Config state
  const [mode, setMode] = useState<'virtual' | 'live'>('virtual');
  const [amount, setAmount] = useState('5');
  const [hasCredentials, setHasCredentials] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Credentials state
  const [privateKey, setPrivateKey] = useState('');
  const [pmApiKey, setPmApiKey] = useState('');
  const [pmApiSecret, setPmApiSecret] = useState('');
  const [pmPassphrase, setPmPassphrase] = useState('');
  const [savingCreds, setSavingCreds] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);

  // Validation & balance
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ valid: boolean; address?: string; error?: string } | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // Load settings on mount
  useEffect(() => {
    (async () => {
      try {
        const config = await api.polymarket.getSettings();
        setMode(config.mode);
        setAmount(config.amount.toString());
        setHasCredentials(config.hasCredentials);
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleSaveCredentials = async () => {
    if (!privateKey || !pmApiKey || !pmApiSecret || !pmPassphrase) {
      toast.error('All 4 fields are required');
      return;
    }
    setSavingCreds(true);
    try {
      await api.polymarket.saveCredentials({
        privateKey,
        apiKey: pmApiKey,
        apiSecret: pmApiSecret,
        apiPassphrase: pmPassphrase,
      });
      setHasCredentials(true);
      setPrivateKey('');
      setPmApiKey('');
      setPmApiSecret('');
      setPmPassphrase('');
      toast.success('Polymarket credentials saved');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to save credentials');
    } finally {
      setSavingCreds(false);
    }
  };

  const handleDeleteCredentials = async () => {
    try {
      await api.polymarket.deleteCredentials();
      setHasCredentials(false);
      setMode('virtual');
      setValidationResult(null);
      setBalance(null);
      toast.success('Credentials removed, switched to virtual mode');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to delete credentials');
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    try {
      const result = await api.polymarket.validateCredentials();
      setValidationResult(result);
      if (result.valid) {
        toast.success('Credentials are valid!');
        // Also fetch balance
        setBalanceLoading(true);
        const bal = await api.polymarket.getBalance();
        setBalance(bal.balance);
        setBalanceLoading(false);
      } else {
        toast.error(result.error || 'Credentials invalid');
      }
    } catch (error: any) {
      toast.error('Validation failed');
    } finally {
      setValidating(false);
    }
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await api.polymarket.saveSettings(mode, parseFloat(amount) || 5);
      toast.success(`Polymarket mode: ${mode.toUpperCase()}, amount: $${amount}`);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleFetchBalance = async () => {
    setBalanceLoading(true);
    try {
      const bal = await api.polymarket.getBalance();
      setBalance(bal.balance);
      if (bal.error) toast.error(bal.error);
    } catch {
      toast.error('Failed to fetch balance');
    } finally {
      setBalanceLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* API Credentials */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Polymarket API Credentials
          </CardTitle>
          <CardDescription>
            Enter your Polymarket CLOB API credentials for live trading.
            Get them from your Polymarket account settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {hasCredentials ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className="text-sm text-emerald-500 font-medium">Credentials configured</span>
                {validationResult?.address && (
                  <code className="text-xs text-muted-foreground font-mono ml-2">
                    {validationResult.address.slice(0, 6)}...{validationResult.address.slice(-4)}
                  </code>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleValidate} disabled={validating}>
                  {validating ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Shield className="mr-2 h-3 w-3" />}
                  Validate
                </Button>
                <Button size="sm" variant="outline" onClick={handleFetchBalance} disabled={balanceLoading}>
                  {balanceLoading ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Wallet className="mr-2 h-3 w-3" />}
                  Balance
                </Button>
                <Button size="sm" variant="destructive" onClick={handleDeleteCredentials}>
                  <Trash2 className="mr-2 h-3 w-3" />
                  Remove
                </Button>
              </div>
              {balance !== null && (
                <div className="text-sm text-muted-foreground">
                  USDC Balance: <span className="font-mono font-semibold text-foreground">${balance.toFixed(2)}</span>
                </div>
              )}
              {validationResult && !validationResult.valid && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">{validationResult.error}</AlertDescription>
                </Alert>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label className="text-xs">Wallet Private Key</Label>
                <div className="flex gap-2">
                  <Input
                    type={showPrivateKey ? 'text' : 'password'}
                    placeholder="0x..."
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0"
                    onClick={() => setShowPrivateKey(!showPrivateKey)}
                  >
                    {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">API Key</Label>
                <Input
                  type="password"
                  placeholder="API Key"
                  value={pmApiKey}
                  onChange={(e) => setPmApiKey(e.target.value)}
                  className="font-mono text-xs"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-xs">API Secret</Label>
                  <Input
                    type="password"
                    placeholder="API Secret"
                    value={pmApiSecret}
                    onChange={(e) => setPmApiSecret(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Passphrase</Label>
                  <Input
                    type="password"
                    placeholder="Passphrase"
                    value={pmPassphrase}
                    onChange={(e) => setPmPassphrase(e.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <Button onClick={handleSaveCredentials} disabled={savingCreds}>
                {savingCreds && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Key className="mr-2 h-4 w-4" />
                Save Credentials
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trading Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Trading Mode
          </CardTitle>
          <CardDescription>
            Choose between virtual (simulated) and live (real money) trading.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Mode</Label>
            <Select
              value={mode}
              onValueChange={(v: string) => {
                if (v === 'live' && !hasCredentials) {
                  toast.error('Save valid API credentials first');
                  return;
                }
                setMode(v as 'virtual' | 'live');
              }}
            >
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="virtual">Virtual (Simulated)</SelectItem>
                <SelectItem value="live">Live (Real Money)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm font-medium">Amount per Trade (USDC)</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-[240px] font-mono"
              placeholder="e.g. 5"
            />
            <p className="text-xs text-muted-foreground">
              How much USDC to wager on each prediction (min $1).
            </p>
          </div>

          {mode === 'live' && (
            <Alert className="border-amber-500/30 bg-amber-500/5">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <AlertDescription className="text-xs">
                <span className="font-medium">Live mode is active.</span> Real USDC will be wagered
                on each prediction. Make sure you have sufficient balance. You can switch back to
                virtual mode at any time.
              </AlertDescription>
            </Alert>
          )}

          <Button onClick={handleSaveSettings} disabled={savingSettings}>
            {savingSettings && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Settings
          </Button>
        </CardContent>
      </Card>

      <Alert>
        <Shield className="h-4 w-4" />
        <AlertDescription className="text-xs">
          Your private key and API credentials are encrypted at rest using AES-256.
          They are never exposed in logs or API responses.
        </AlertDescription>
      </Alert>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Danger Zone Tab
// ---------------------------------------------------------------------------

function DangerZoneTab() {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.client.delete('/api/auth/account');
      toast.success('Account deleted successfully');
      window.location.href = '/login';
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Failed to delete account');
    } finally {
      setDeleting(false);
      setDeleteDialogOpen(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Delete Account
          </CardTitle>
          <CardDescription>
            Permanently delete your account and all associated data. This action is irreversible.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <Trash2 className="h-4 w-4" />
            <AlertDescription>
              Deleting your account will permanently remove all your data, API keys, trading
              history, and settings. This action cannot be undone.
            </AlertDescription>
          </Alert>

          <div className="mt-4">
            <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete my account
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Are you absolutely sure?</DialogTitle>
                  <DialogDescription>
                    This action cannot be undone. This will permanently delete your account and
                    remove all your data from our servers.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2 py-4">
                  <Label>
                    Type <span className="font-semibold text-destructive">DELETE</span> to confirm
                  </Label>
                  <Input
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder="Type DELETE to confirm"
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={confirmText !== 'DELETE' || deleting}
                    onClick={handleDeleteAccount}
                  >
                    {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Delete Account
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// About Tab
// ---------------------------------------------------------------------------

function AboutTab() {
  const pillars = [
    {
      icon: Target,
      title: 'Signal Detection',
      description:
        'Our engine continuously scans 10+ crypto pairs on the 15-minute timeframe, analyzing momentum indicators (RSI, MACD, Bollinger Bands) combined with multi-timeframe confirmation (1H, 4H) to identify high-probability entry signals.',
    },
    {
      icon: TrendingUp,
      title: 'Momentum Trading',
      description:
        'Each agent trades a momentum-based strategy: enter on confirmed trend alignment across timeframes, ride the move with trailing stops, and exit when momentum fades. Positions are sized based on volatility (ATR) and account equity.',
    },
    {
      icon: ShieldCheck,
      title: 'Risk Governance',
      description:
        'Every position is protected by a hard stop-loss (max 2% risk per trade), proactive limit orders, and a real-time exit system that monitors drawdown, NFS (Negative Feedback Signals), and trailing breach conditions to cut losses early.',
    },
    {
      icon: Zap,
      title: 'Real-Time Execution',
      description:
        'Agents execute 24/7 autonomously on Binance Futures via WebSocket feeds. Sub-second order placement, automatic leverage management, and position synchronization ensure no signal is missed.',
    },
    {
      icon: BarChart3,
      title: 'Walk-Forward Validation',
      description:
        'Before going live, every strategy parameter is validated through walk-forward backtesting across multiple market regimes. This ensures robustness against overfitting and adapts to changing market conditions.',
    },
    {
      icon: Clock,
      title: 'Cash Mode & Regime Detection',
      description:
        'When market conditions deteriorate (low ADX, high volatility, unfavorable trend), agents automatically switch to cash mode — staying flat until conditions improve. This preserves capital during choppy or bear markets.',
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: 'linear-gradient(135deg, #3b82f6, #34d399)' }}
            >
              <Info className="h-5 w-5 text-white" />
            </div>
            <div>
              <CardTitle>About Remezz</CardTitle>
              <CardDescription>How our autonomous trading agents work</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Remezz is an autonomous crypto trading platform powered by AI-driven signal detection and
            momentum-based execution. Each agent operates independently, scanning the market for
            high-probability setups, managing risk in real-time, and adapting to changing market
            regimes — all without manual intervention.
          </p>
          <div
            className="rounded-lg p-3 text-sm font-medium"
            style={{ background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(52, 211, 153, 0.1))', border: '1px solid rgba(52, 211, 153, 0.2)' }}
          >
            <span style={{ background: 'linear-gradient(135deg, #3b82f6, #34d399)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Detect the signal. Trade the momentum. Manage the risk.
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {pillars.map((pillar) => {
          const Icon = pillar.icon;
          return (
            <Card key={pillar.title}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-3">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(52, 211, 153, 0.15))' }}
                  >
                    <Icon className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-foreground">{pillar.title}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {pillar.description}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardContent className="py-4">
          <p className="text-center text-xs text-muted-foreground">
            Remezz v5.89 &middot; Momentum Strategy Engine &middot; Built for autonomous crypto trading
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Settings Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

  const loadUserInfo = useCallback(async () => {
    try {
      const result = await api.client.get('/api/auth/me');
      setUserInfo(result.data.user);
    } catch (error) {
      console.error('Failed to load user info:', error);
    }
  }, []);

  useEffect(() => {
    loadUserInfo();
  }, [loadUserInfo]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Tabs defaultValue="about" className="w-full">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="about" className="flex items-center gap-1.5">
            <Info className="h-4 w-4" />
            <span className="hidden sm:inline">About</span>
          </TabsTrigger>
          <TabsTrigger value="profile" className="flex items-center gap-1.5">
            <User className="h-4 w-4" />
            <span className="hidden sm:inline">Profile</span>
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="flex items-center gap-1.5">
            <Key className="h-4 w-4" />
            <span className="hidden sm:inline">API Keys</span>
          </TabsTrigger>
          <TabsTrigger value="polymarket" className="flex items-center gap-1.5">
            <DollarSign className="h-4 w-4" />
            <span className="hidden sm:inline">Polymarket</span>
          </TabsTrigger>
          <TabsTrigger value="preferences" className="flex items-center gap-1.5">
            <Settings className="h-4 w-4" />
            <span className="hidden sm:inline">Preferences</span>
          </TabsTrigger>
          <TabsTrigger value="danger" className="flex items-center gap-1.5">
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">Danger</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="about">
          <AboutTab />
        </TabsContent>

        <TabsContent value="profile">
          <ProfileTab userInfo={userInfo} onUserUpdate={loadUserInfo} />
        </TabsContent>

        <TabsContent value="api-keys">
          <ApiKeysTab />
        </TabsContent>

        <TabsContent value="polymarket">
          <PolymarketTab />
        </TabsContent>

        <TabsContent value="preferences">
          <PreferencesTab />
        </TabsContent>

        <TabsContent value="danger">
          <DangerZoneTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
