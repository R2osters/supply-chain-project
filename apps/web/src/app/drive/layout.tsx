import type { Metadata, Viewport } from 'next';
import { DriveServiceWorker } from './register-sw';

export const metadata: Metadata = {
  title: 'SCIP — Driver',
  description: 'Report this vehicle’s position while the screen is open.',
  manifest: '/drive.webmanifest',
  appleWebApp: {
    // iOS ignores the manifest entirely and reads these instead. Without them, "Add to Home
    // Screen" produces a bookmark that opens in Safari with its chrome, not a standalone app.
    capable: true,
    title: 'SCIP Drive',
    statusBarStyle: 'black-translucent',
  },
  icons: { apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: '#08090a',
  colorScheme: 'dark',
  // A driver glancing at a phone on a dashboard mount must not zoom the layout by brushing it,
  // and the status block is already sized for arm's length.
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function DriveLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DriveServiceWorker />
      {children}
    </>
  );
}
