'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { shouldToast, TOASTED_KEY, type UpdateStatus } from '@/app/(app)/settings/_components/update-format';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { desktopInvoke } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered: the toast may show once more, nothing worse.
  }
}

/**
 * Says once per version, in SCIP's window, that an update is ready. The install itself stays a
 * deliberate click (Settings → Mises à jour): it closes SCIP for a minute or two.
 */
export function UpdateToast() {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const { user, can } = useAuth();
  const invoke = desktopInvoke();

  const status = useQuery({
    queryKey: ['desktop', 'update'],
    queryFn: () => invoke!<UpdateStatus>('update_status'),
    // Settings, where the update is installed, is for administrators only.
    enabled: invoke !== null && Boolean(user) && !user?.mustChangePassword && can('company:update'),
    refetchInterval: 5 * 60_000,
  });

  useEffect(() => {
    const version = shouldToast(status.data, read(TOASTED_KEY));
    if (!version) return;
    write(TOASTED_KEY, version);
    toast.show({
      tone: 'info',
      message: t('update.toast.ready', { version }),
      action: { label: t('update.toast.open'), onClick: () => router.push('/settings') },
      durationMs: 15_000,
    });
  }, [status.data, toast, t, router]);

  return null;
}
