import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

/**
 * One family, three cuts (charte §04). Plex Sans for everything; Condensed for key figures only;
 * Mono for whatever reads as data — plates, IDs, times, sources.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  variable: '--font-plex-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const plexCondensed = IBM_Plex_Sans_Condensed({
  subsets: ['latin'],
  variable: '--font-plex-condensed',
  weight: ['500', '600'],
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-plex-mono',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SCIP — Supply Chain Intelligence Platform',
  description:
    'Track cargo from supplier to customer, and decide what to order, from whom and when.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#e3e4e6' },
    { media: '(prefers-color-scheme: dark)', color: '#121314' },
  ],
};

/**
 * Sets `data-theme` before first paint so a dark-mode user never sees a light flash. The choice
 * lives in localStorage; with none stored, the OS preference decides.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('scip.theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexCondensed.variable} ${plexMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
