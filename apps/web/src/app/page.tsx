import { redirect } from 'next/navigation';

export default function RootPage() {
  // The dashboard is the landing surface; the app layout bounces to /login when there is no
  // session, so a single redirect covers both the signed-in and signed-out cases.
  redirect('/dashboard');
}
