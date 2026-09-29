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
    // Opaque, not translucent: the screen is light by default, and a translucent bar would lay
    // white status text over white content.
    statusBarStyle: 'black',
  },
  icons: { apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  // Charte ink: the same near-black as the app icon, legible against any wallpaper.
  themeColor: '#141516',
  colorScheme: 'light',
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
