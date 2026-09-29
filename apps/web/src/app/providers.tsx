'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import { I18nProvider } from '@/lib/i18n';
import { ThemeProvider } from '@/lib/theme';
import { ToastProvider } from '@/components/toast';
import { routeExternalLinksToBrowser } from '@/lib/external-links';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Operational data goes stale fast; 15 s keeps the dashboard honest without
            // hammering the API on every tab switch.
            staleTime: 15_000,
            refetchOnWindowFocus: true,
            // A 401 is handled by the API client's refresh path; retrying it here would
            // just delay the redirect to the login screen.
            retry: (failureCount, error) => {
              const status = (error as { status?: number })?.status;
              if (status === 401 || status === 403 || status === 404) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  useEffect(() => routeExternalLinksToBrowser(), []);

  return (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>{children}</AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
