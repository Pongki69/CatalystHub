import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';

interface AuthValue {
  user: User | null;
  loading: boolean;
  isGuest: boolean;
  sessionError: string;
  retrySession: () => void;
  signIn: (user: User, token: string, guest?: boolean) => void;
  updateUser: (user: User) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [isGuest, setIsGuest] = useState(sessionStorage.getItem('catalysthub_guest_mode') === 'true');

  async function restoreSession() {
    const token = sessionStorage.getItem('catalysthub_token');
    if (!token) {
      sessionStorage.removeItem('catalysthub_guest_mode');
      setIsGuest(false);
      setUser(null);
      setSessionError('');
      setLoading(false);
      return;
    }

    setLoading(true);
    setSessionError('');
    try {
      const response = await api.get('/auth/me');
      setUser(response.data.data.user);
    } catch (error) {
      const status = responseStatus(error);
      if (status === 401 || status === 403) {
        sessionStorage.removeItem('catalysthub_token');
        sessionStorage.removeItem('catalysthub_guest_mode');
        setIsGuest(false);
        setUser(null);
      } else {
        // Keep the saved session so a temporary API or database outage can be retried.
        setSessionError('CatalystHub could not verify your session. Check the connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void restoreSession(); }, []);

  const signIn = (nextUser: User, token: string, guest = false) => {
    sessionStorage.setItem('catalysthub_guest_mode', String(guest));
    sessionStorage.setItem('catalysthub_token', token);
    setIsGuest(guest);
    setSessionError('');
    setUser(nextUser);
  };

  const updateUser = (nextUser: User) => setUser(nextUser);

  const signOut = () => {
    sessionStorage.removeItem('catalysthub_token');
    sessionStorage.removeItem('catalysthub_guest_mode');
    setIsGuest(false);
    setSessionError('');
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, loading, isGuest, sessionError, retrySession: () => { void restoreSession(); }, signIn, updateUser, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
