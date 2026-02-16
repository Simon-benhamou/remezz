import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  User,
  Lock,
  Mail,
  Key,
  Loader2,
  TrendingUp,
  Shield,
  Zap,
  BarChart3,
  Bot,
  ArrowRight,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';

// ─── Schemas ─────────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1, 'Please enter your email'),
  password: z.string().min(1, 'Please enter your password'),
});

const registerSchema = z
  .object({
    registrationCode: z
      .string()
      .min(9, 'Registration code must be exactly 9 characters')
      .max(9, 'Registration code must be exactly 9 characters'),
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(20, 'Username must be less than 20 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, and underscores'),
    email: z.string().email('Enter a valid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type LoginFormValues = z.infer<typeof loginSchema>;
type RegisterFormValues = z.infer<typeof registerSchema>;

const REGISTER_ERRORS: Record<string, string> = {
  missing_required_fields: 'Please fill in all required fields.',
  invalid_registration_code: 'Invalid registration code.',
  username_must_be_3_20_chars: 'Username must be 3-20 characters.',
  password_must_be_at_least_6_chars: 'Password must be at least 6 characters.',
  invalid_email_format: 'Enter a valid email address.',
  username_already_exists: 'This username is already taken.',
  email_already_exists: 'This email is already registered.',
  server_error: 'Server error, please try again later.',
};

// ─── Features ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: Bot,
    title: 'Autonomous AI Agents',
    desc: 'Deploy agents that trade 24/7 with momentum detection and adaptive risk management.',
  },
  {
    icon: TrendingUp,
    title: 'Proven Strategy',
    desc: '+1,308% ROI backtested over 12 months across 10 crypto futures pairs.',
  },
  {
    icon: Shield,
    title: 'Smart Risk Control',
    desc: 'Trailing stops, NFS exits, and capital pool management protect your positions.',
  },
  {
    icon: Zap,
    title: 'Real-time Execution',
    desc: 'WebSocket-first architecture with sub-second signal detection and order placement.',
  },
];

const STATS = [
  { value: '61%', label: 'Win Rate' },
  { value: '10+', label: 'Crypto Pairs' },
  { value: '24/7', label: 'Monitoring' },
  { value: '<1s', label: 'Execution' },
];

// ─── Component ───────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn, isLoading, isAuthenticated } = useAuth();

  const isRegisterRoute = location.pathname === '/register';
  const [activeTab, setActiveTab] = React.useState<'login' | 'register'>(
    isRegisterRoute ? 'register' : 'login'
  );
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/operations', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  // Login form
  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema as any),
    defaultValues: { username: '', password: '' },
  });

  // Register form
  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema as any),
    defaultValues: {
      registrationCode: '',
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  const onLogin = async (values: LoginFormValues) => {
    try {
      const result = await api.auth.login(values.username, values.password);
      if (result?.token) {
        await signIn(result.token);
        toast.success(`Welcome back, ${result.user.username}!`);
        navigate('/operations', { replace: true });
      } else {
        throw new Error('Invalid response');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Login failed');
    }
  };

  const onRegister = async (values: RegisterFormValues) => {
    setIsSubmitting(true);
    try {
      const response = await api.client.post('/api/auth/register', {
        username: values.username,
        email: values.email,
        password: values.password,
        registrationCode: values.registrationCode,
      });
      const { token, user } = response.data;
      if (!token) throw new Error('Invalid response');
      await signIn(token);
      toast.success(`Welcome aboard, ${user?.username || values.username}!`);
      navigate('/operations', { replace: true });
    } catch (error: any) {
      const code: string | undefined = error?.response?.data?.error;
      toast.error((code && REGISTER_ERRORS[code]) || error?.message || 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="landing-root">
      <style>{`
        .landing-root {
          min-height: 100vh;
          background: #060c19;
          position: relative;
          overflow: hidden;
        }
        .landing-nav {
          position: relative;
          z-index: 10;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 24px 40px;
          max-width: 1400px;
          margin: 0 auto;
        }
        .landing-main {
          position: relative;
          z-index: 10;
          max-width: 1400px;
          margin: 0 auto;
          padding: 40px 40px 80px;
        }
        .landing-cols {
          display: flex;
          gap: 80px;
          align-items: center;
        }
        .landing-hero {
          flex: 1 1 480px;
          min-width: 0;
        }
        .landing-auth {
          flex: 0 1 420px;
          min-width: 0;
        }
        .landing-h1 {
          font-size: 52px;
          font-weight: 800;
          line-height: 1.1;
          color: #f1f5f9;
          margin: 0 0 20px;
          letter-spacing: -0.03em;
        }
        .landing-features {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 16px;
        }
        .landing-stats {
          display: flex;
          gap: 32px;
          margin-bottom: 48px;
          flex-wrap: wrap;
        }
        .landing-pw-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        @media (max-width: 1024px) {
          .landing-cols { gap: 40px; }
          .landing-h1 { font-size: 40px; }
        }
        @media (max-width: 768px) {
          .landing-nav { padding: 16px 20px; }
          .landing-main { padding: 20px 20px 60px; }
          .landing-cols { flex-direction: column; gap: 32px; }
          .landing-hero { flex: 1 1 auto; }
          .landing-auth { flex: 1 1 auto; width: 100%; max-width: 420px; }
          .landing-h1 { font-size: 32px; }
          .landing-features { grid-template-columns: 1fr; }
          .landing-stats { gap: 20px; }
        }
        @media (max-width: 480px) {
          .landing-nav { padding: 14px 16px; }
          .landing-main { padding: 16px 16px 40px; }
          .landing-h1 { font-size: 28px; }
          .landing-pw-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* Animated background */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', top: '-20%', left: '-10%', width: '50vw', height: '50vw', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59, 130, 246, 0.12) 0%, transparent 70%)', filter: 'blur(60px)',
        }} />
        <div style={{
          position: 'absolute', bottom: '-15%', right: '-5%', width: '45vw', height: '45vw', borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(52, 211, 153, 0.10) 0%, transparent 70%)', filter: 'blur(60px)',
        }} />
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'linear-gradient(rgba(59, 130, 246, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(59, 130, 246, 0.03) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
        }} />
      </div>

      {/* Nav */}
      <nav className="landing-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/remezz-logo.svg" alt="Remezz" style={{ height: 32 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setActiveTab('login')}
            style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 14, fontWeight: 500,
              color: activeTab === 'login' ? '#f1f5f9' : '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer',
            }}
          >
            Sign In
          </button>
          <button
            onClick={() => setActiveTab('register')}
            style={{
              padding: '8px 16px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              color: '#fff', background: 'linear-gradient(135deg, #3b82f6, #34d399)', border: 'none', cursor: 'pointer',
            }}
          >
            Get Started
          </button>
        </div>
      </nav>

      {/* Main content */}
      <div className="landing-main">
        <div className="landing-cols">

          {/* Left: Hero */}
          <div className="landing-hero">
            {/* Badge */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 20,
              background: 'rgba(52, 211, 153, 0.08)', border: '1px solid rgba(52, 211, 153, 0.2)', marginBottom: 28,
            }}>
              <BarChart3 size={14} style={{ color: '#34d399' }} />
              <span style={{ fontSize: 13, fontWeight: 500, color: '#34d399' }}>AI-Powered Crypto Trading</span>
            </div>

            <h1 className="landing-h1">
              Trade smarter{' '}
              <span style={{
                background: 'linear-gradient(135deg, #3b82f6, #34d399)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
              }}>
                with AI
              </span>
              <br />
              that never sleeps.
            </h1>

            <p style={{ fontSize: 18, lineHeight: 1.6, color: '#94a3b8', margin: '0 0 40px', maxWidth: 500 }}>
              Deploy autonomous trading agents that monitor crypto futures 24/7,
              detect momentum signals, and execute with precision risk management.
            </p>

            {/* Stats */}
            <div className="landing-stats">
              {STATS.map((stat) => (
                <div key={stat.label}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: '#f1f5f9', fontFamily: "'JetBrains Mono', monospace" }}>
                    {stat.value}
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase' as const, letterSpacing: '0.08em', marginTop: 2 }}>
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>

            {/* Features grid */}
            <div className="landing-features">
              {FEATURES.map((feat) => (
                <div
                  key={feat.title}
                  style={{
                    padding: '16px 18px', borderRadius: 14,
                    background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(40, 68, 105, 0.3)',
                  }}
                >
                  <feat.icon size={18} style={{ color: '#3b82f6', marginBottom: 8 }} />
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0', marginBottom: 4 }}>{feat.title}</div>
                  <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.5 }}>{feat.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Auth card */}
          <div className="landing-auth">
            <div style={{
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(40, 68, 105, 0.4)',
              borderRadius: 20,
              padding: 36,
              backdropFilter: 'blur(20px)',
              boxShadow: '0 40px 80px rgba(0, 0, 0, 0.3), 0 0 60px rgba(59, 130, 246, 0.06)',
            }}>
              {/* Tab switcher */}
              <div style={{
                display: 'flex',
                background: 'rgba(15, 23, 42, 0.6)',
                borderRadius: 10,
                padding: 3,
                marginBottom: 28,
                border: '1px solid rgba(40, 68, 105, 0.3)',
              }}>
                <button
                  onClick={() => setActiveTab('login')}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    color: activeTab === 'login' ? '#fff' : '#64748b',
                    background: activeTab === 'login' ? 'linear-gradient(135deg, #3b82f6, #34d399)' : 'transparent',
                  }}
                >
                  Sign In
                </button>
                <button
                  onClick={() => setActiveTab('register')}
                  style={{
                    flex: 1,
                    padding: '10px 0',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    color: activeTab === 'register' ? '#fff' : '#64748b',
                    background: activeTab === 'register' ? 'linear-gradient(135deg, #3b82f6, #34d399)' : 'transparent',
                  }}
                >
                  Register
                </button>
              </div>

              {/* Login form */}
              {activeTab === 'login' && (
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', margin: '0 0 4px 0' }}>
                    Welcome back
                  </h2>
                  <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 24px 0' }}>
                    Sign in to your trading dashboard
                  </p>

                  <Form {...loginForm}>
                    <form onSubmit={loginForm.handleSubmit(onLogin)} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      <FormField
                        control={loginForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-slate-300 text-[13px]">Email</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                <Input
                                  placeholder="name@example.com"
                                  autoComplete="username"
                                  className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={loginForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-slate-300 text-[13px]">Password</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                <Input
                                  type="password"
                                  placeholder="Enter your password"
                                  autoComplete="current-password"
                                  className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <button
                        type="submit"
                        disabled={isLoading}
                        style={{
                          width: '100%',
                          height: 44,
                          borderRadius: 10,
                          border: 'none',
                          fontSize: 15,
                          fontWeight: 600,
                          color: '#fff',
                          background: 'linear-gradient(135deg, #3b82f6, #34d399)',
                          cursor: isLoading ? 'wait' : 'pointer',
                          opacity: isLoading ? 0.6 : 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 8,
                          marginTop: 4,
                          boxShadow: '0 8px 24px rgba(59, 130, 246, 0.25)',
                        }}
                      >
                        {isLoading && <Loader2 size={16} className="animate-spin" />}
                        Sign In
                        <ArrowRight size={16} />
                      </button>
                    </form>
                  </Form>

                  <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', marginTop: 20 }}>
                    Don't have an account?{' '}
                    <button
                      onClick={() => setActiveTab('register')}
                      style={{ color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}
                    >
                      Create one
                    </button>
                  </p>
                </div>
              )}

              {/* Register form */}
              {activeTab === 'register' && (
                <div>
                  <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', margin: '0 0 4px 0' }}>
                    Create your account
                  </h2>
                  <p style={{ fontSize: 14, color: '#64748b', margin: '0 0 24px 0' }}>
                    Start trading in minutes
                  </p>

                  <Form {...registerForm}>
                    <form onSubmit={registerForm.handleSubmit(onRegister)} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <FormField
                        control={registerForm.control}
                        name="registrationCode"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-slate-300 text-[13px]">Registration Code</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                <Input
                                  placeholder="9-character code"
                                  autoComplete="one-time-code"
                                  className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={registerForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-slate-300 text-[13px]">Username</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                <Input
                                  placeholder="Choose a username"
                                  autoComplete="username"
                                  className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={registerForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-slate-300 text-[13px]">Email</FormLabel>
                            <FormControl>
                              <div className="relative">
                                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                <Input
                                  placeholder="name@example.com"
                                  autoComplete="email"
                                  className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                  {...field}
                                />
                              </div>
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="landing-pw-grid">
                        <FormField
                          control={registerForm.control}
                          name="password"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-slate-300 text-[13px]">Password</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                  <Input
                                    type="password"
                                    placeholder="Min 6 chars"
                                    autoComplete="new-password"
                                    className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                    {...field}
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />

                        <FormField
                          control={registerForm.control}
                          name="confirmPassword"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-slate-300 text-[13px]">Confirm</FormLabel>
                              <FormControl>
                                <div className="relative">
                                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
                                  <Input
                                    type="password"
                                    placeholder="Re-enter"
                                    autoComplete="new-password"
                                    className="pl-9 h-11 bg-[#0c1322] border-[rgba(40,68,105,0.4)] text-slate-200 placeholder:text-slate-600"
                                    {...field}
                                  />
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={isSubmitting || isLoading}
                        style={{
                          width: '100%',
                          height: 44,
                          borderRadius: 10,
                          border: 'none',
                          fontSize: 15,
                          fontWeight: 600,
                          color: '#fff',
                          background: 'linear-gradient(135deg, #3b82f6, #34d399)',
                          cursor: (isSubmitting || isLoading) ? 'wait' : 'pointer',
                          opacity: (isSubmitting || isLoading) ? 0.6 : 1,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 8,
                          marginTop: 4,
                          boxShadow: '0 8px 24px rgba(59, 130, 246, 0.25)',
                        }}
                      >
                        {(isSubmitting || isLoading) && <Loader2 size={16} className="animate-spin" />}
                        Create Account
                        <ArrowRight size={16} />
                      </button>
                    </form>
                  </Form>

                  <div style={{
                    marginTop: 16,
                    padding: '10px 14px',
                    borderRadius: 10,
                    background: 'rgba(234, 179, 8, 0.06)',
                    border: '1px solid rgba(234, 179, 8, 0.15)',
                  }}>
                    <p style={{ fontSize: 12, color: '#94a3b8', margin: 0 }}>
                      A valid registration code is required. Contact your Remezz administrator for access.
                    </p>
                  </div>

                  <p style={{ textAlign: 'center', fontSize: 13, color: '#64748b', marginTop: 18 }}>
                    Already have an account?{' '}
                    <button
                      onClick={() => setActiveTab('login')}
                      style={{ color: '#3b82f6', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}
                    >
                      Sign in
                    </button>
                  </p>
                </div>
              )}
            </div>

            {/* Trust line */}
            <p style={{ textAlign: 'center', fontSize: 11, color: '#475569', marginTop: 20, letterSpacing: '0.04em' }}>
              Remezz &middot; Signal Detection &middot; Momentum Trading &middot; AI Risk Governance
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
