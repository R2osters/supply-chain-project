import type { Metadata, Viewport } from 'next';
import { Archivo, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

/**
 * Archivo for the interface: a grotesque with a slightly condensed, signage feel — it reads as
 * industrial wayfinding rather than as another product landing page. JetBrains Mono carries every
 * number, code and identifier, because tracking numbers and SKUs are literally monospaced data
 * and a column of quantities has to line up.
 */
const archivo = Archivo({
  subsets: ['latin'],
  variable: '--font-archivo',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  weight: ['400', '500', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SCIP — Supply Chain Intelligence Platform',
  description:
    'Track cargo from supplier to customer, and decide what to order, from whom and when.',
};

export const viewport: Viewport = {
  themeColor: '#08090a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${jetbrains.variable}`}>
      <body className="grain min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
