import { useEffect } from 'react';
import { useAuthStore } from '../store';
import { api } from '../api';

export function useAuth() {
  const {
    user,
    apiKey,
    isAuthenticated,
    isLoading,
    error,
    setUser,
    setApiKey,
    setLoading,
    setError,
    login,
    logout,
    clearError,
  } = useAuthStore();

  // Auto-check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      const storedApiKey = apiKey;

      if (!storedApiKey) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        // Validate token with server
        const response = await api.client.get('/api/auth/me');
        const userData = response.data;

        // Update user data if needed
        if (!user || user.id !== userData.id) {
          setUser(userData);
        }

        clearError();
      } catch (err: any) {
        console.error('Auth check failed:', err);
        setError(err.message || 'Authentication failed');
        logout(); // Clear invalid auth state
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [apiKey, user, setUser, setLoading, setError, logout, clearError]);

  const signIn = async (apiKey: string) => {
    setLoading(true);
    setError(null);

    try {
      // Validate the API key
      const response = await api.client.get('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      const userData = response.data;
      login(apiKey, userData);
    } catch (err: any) {
      setError(err.message || 'Invalid API key');
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const signOut = () => {
    logout();
  };

  return {
    user,
    apiKey,
    isAuthenticated,
    isLoading,
    error,
    signIn,
    signOut,
    clearError,
  };
}