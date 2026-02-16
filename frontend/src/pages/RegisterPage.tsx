import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Key, User, Mail, Lock, Github, Globe, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { toast } from '@/lib/toast';
import { AUTH_FEATURES, HERO_METRICS } from './authContent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from '@/components/ui/form';

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
      .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
    email: z.string().email('Enter a valid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type RegisterFormValues = z.infer<typeof registerSchema>;

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
  const navigate = useNavigate();
  const { signIn, isLoading, isAuthenticated } = useAuth();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const form = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema as any),
    defaultValues: {
      registrationCode: '',
      username: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  });

  React.useEffect(() => {
    if (isAuthenticated) {
      navigate('/operations', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const onSubmit = async (values: RegisterFormValues) => {
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
      toast.success(`Welcome aboard, ${user?.username || values.username}!`);
      navigate('/operations', { replace: true });
    } catch (error: any) {
      const errorCode: string | undefined = error?.response?.data?.error;
      const fallbackMessage = error?.message || 'Registration failed';
      toast.error((errorCode && ERROR_MESSAGES[errorCode]) || fallbackMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="auth-layout">
      <div className="auth-panel">
        <img src="/remezz-logo.svg" alt="Remezz" className="h-9 mb-4" />
        <h1 className="auth-panel__title">Remezz</h1>
        <p className="auth-panel__subtitle">
          Build resilient algorithmic strategies with AI copilots that supervise risk, analyse market regimes, and execute with precision.
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
              Create your account
            </h2>
            <p className="text-sm text-[var(--text-muted)]">
              Join the Remezz platform in minutes
            </p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="registrationCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Registration Code</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          placeholder="Enter your registration code"
                          autoComplete="one-time-code"
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
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          placeholder="Choose a username"
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
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          placeholder="name@example.com"
                          autoComplete="email"
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
                          placeholder="Create a strong password"
                          autoComplete="new-password"
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
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm Password</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--accent)]" />
                        <Input
                          type="password"
                          placeholder="Re-enter your password"
                          autoComplete="new-password"
                          className="pl-9 h-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                className="w-full h-10"
                disabled={isSubmitting || isLoading}
              >
                {(isSubmitting || isLoading) && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Create Account
              </Button>
            </form>
          </Form>

          <Alert className="mt-6 border-yellow-500/40 bg-yellow-500/10">
            <AlertDescription className="text-sm text-[var(--text-muted)]">
              A valid registration code is required to onboard new desks. Contact your Remezz administrator if you need access.
            </AlertDescription>
          </Alert>

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

          <div className="my-6 h-px w-full bg-[var(--border-subtle)]" />

          <p className="text-center text-sm text-[var(--text-muted)]">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
