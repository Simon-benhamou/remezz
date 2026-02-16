import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { User, Lock, Github, Globe, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { toast } from '@/lib/toast';
import { AUTH_FEATURES, HERO_METRICS } from './authContent';
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

const loginSchema = z.object({
  username: z.string().min(1, 'Please enter your email'),
  password: z.string().min(1, 'Please enter your password'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const navigate = useNavigate();
  const { signIn, isLoading, isAuthenticated } = useAuth();

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema as any),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/operations', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onSubmit = async (values: LoginFormValues) => {
    try {
      const result = await api.auth.login(values.username, values.password);
      if (result?.token) {
        await signIn(result.token);
        toast.success(`Welcome back, ${result.user.username}!`);
        navigate('/operations', { replace: true });
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Login failed');
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-panel">
        <img src="/remezz-logo.svg" alt="Remezz" className="h-9 mb-4" />
        <h1 className="auth-panel__title">Remezz</h1>
        <p className="auth-panel__subtitle">
          Trade smarter with AI agents that monitor markets 24/7, react instantly to volatility, and keep risk under control.
        </p>
        <div className="auth-panel__metrics">
          {HERO_METRICS.map((metric) => (
            <div key={metric.label} className="auth-panel__metric">
              <span className="auth-panel__metric-label">{metric.label}</span>
              <span className="auth-panel__metric-value">{metric.value}</span>
            </div>
          ))}
        </div>
        <div className="auth-panel__features">
          {AUTH_FEATURES.map((feature) => (
            <div key={feature} className="auth-panel__feature">
              <span className="auth-panel__feature-icon">
                <span role="img" aria-label="check">
                  &#10003;
                </span>
              </span>
              <span className="auth-panel__feature-label">{feature}</span>
            </div>
          ))}
        </div>
        <div className="auth-panel__footer">
          Trusted by professional quant desks and high-frequency trading teams worldwide.
        </div>
      </div>

      <div className="auth-form-wrapper">
        <div className="auth-form-card rounded-xl border border-border bg-card p-8">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
              Welcome back
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              Sign in to your account to continue
            </p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          placeholder="name@example.com"
                          autoComplete="username"
                          className="pl-9 h-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          type="password"
                          placeholder="Enter your password"
                          autoComplete="current-password"
                          className="pl-9 h-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-between mb-4">
                <Link to="/register" className="text-sm text-primary hover:underline">
                  Need an account?
                </Link>
                <Link to="/reset-password" className="text-sm text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>

              <Button
                type="submit"
                className="w-full h-10"
                disabled={isLoading}
              >
                {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Sign In
              </Button>
            </form>
          </Form>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-[var(--border-subtle)]" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-card px-2 text-[var(--text-muted)]">Or continue with</span>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button variant="outline" className="w-full" disabled>
              <Globe className="mr-2 h-4 w-4" />
              Google (coming soon)
            </Button>
            <Button variant="outline" className="w-full" disabled>
              <Github className="mr-2 h-4 w-4" />
              GitHub (coming soon)
            </Button>
          </div>

          <p className="mt-6 text-xs text-[var(--text-muted)]">
            By continuing, you agree to the{' '}
            <a href="https://remezz.io/terms" target="_blank" rel="noreferrer" className="text-primary hover:underline">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="https://remezz.io/privacy" target="_blank" rel="noreferrer" className="text-primary hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
