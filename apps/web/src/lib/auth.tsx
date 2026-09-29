'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  api,
  getRefreshToken,
  onPasswordChangeRequired,
  onSessionLost,
  setAccessToken,
  setRefreshToken,
  type SessionUser,
} from './api';
import { roleHasPermission, type Permission, type UserRole } from '@scip/shared';

interface AuthState {
  user: SessionUser | null;
  /** True until the initial silent refresh has resolved, so pages do not flash the login screen. */
  loading: boolean;
  /** Resolves with the signed-in account, so the caller can route it to its own home page. */
  signIn(email: string, password: string): Promise<SessionUser>;
  signOut(): Promise<void>;
  /**
   * Changes the signed-in user's password and keeps them signed in. The API ends every session
   * on a password change, this one included, so this signs in again with the new password.
   * Also how an account leaves its temporary password (`mustChangePassword`).
   */
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Re-reads the profile (role, names, `mustChangePassword`) from the API. */
  refreshUser(): Promise<void>;
  /** Same permission matrix the API enforces — the UI hides what the server would refuse. */
  can(permission: Permission): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(() => {
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  // Restore a session from the persisted refresh token on first paint.
  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getRefreshToken()) {
        setLoading(false);
        return;
      }
      try {
        // Any authenticated call triggers the client's own refresh path on 401.
        const profile = await api<SessionUser>('/auth/me');
        if (!cancelled) setUser(profile);
      } catch {
        if (!cancelled) clear();
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    onSessionLost(() => {
      clear();
      router.replace('/login');
    });

    // A request refused with "choose your password first" (a temporary password handed out
    // while this tab was open): flag the session once, and the shell shows the password screen.
    onPasswordChangeRequired(() => {
      setUser((current) => (current && !current.mustChangePassword ? { ...current, mustChangePassword: true } : current));
    });

    void restore();
    return () => {
      cancelled = true;
      onPasswordChangeRequired(null);
    };
  }, [clear, router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const result = await api<{ accessToken: string; refreshToken: string; user: SessionUser }>(
      '/auth/login',
      { method: 'POST', body: { email, password } },
    );
    setAccessToken(result.accessToken);
    setRefreshToken(result.refreshToken);
    setUser(result.user);
    return result.user;
  }, []);

  const signOut = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      // Best effort: a failed logout call must not trap the user in a session they left.
      await api('/auth/logout', { method: 'POST', body: { refreshToken } }).catch(() => undefined);
    }
    clear();
    router.replace('/login');
  }, [clear, router]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const email = user?.email;
      await api('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      if (!email) return;
      try {
        // A fresh session with the new password, whose profile no longer asks for a change.
        await signIn(email, newPassword);
      } catch {
        // The password did change; only the new session failed. Sign in again by hand.
        clear();
        router.replace('/login');
      }
    },
    [user?.email, signIn, clear, router],
  );

  const refreshUser = useCallback(async () => {
    setUser(await api<SessionUser>('/auth/me'));
  }, []);

  const can = useCallback(
    (permission: Permission) =>
      user ? roleHasPermission(user.role as UserRole, permission) : false,
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, changePassword, refreshUser, can }),
    [user, loading, signIn, signOut, changePassword, refreshUser, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
