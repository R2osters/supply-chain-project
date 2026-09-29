'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '@/lib/i18n';
import { isActive } from '@/lib/nav';

/**
 * Tabs between routes the charte presents as one screen ("Allocation & Scénarios",
 * "Fournisseurs & Commandes"). Each tab is still its own route, so deep links keep working.
 */
export function SubTabs({ tabs }: { tabs: Array<{ href: string; labelKey: TranslationKey; icon?: LucideIcon }> }) {
  const { t } = useI18n();
  const pathname = usePathname();
  return (
    <nav className="segmented self-start" aria-label="sections">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <Link key={tab.href} href={tab.href} aria-current={isActive(pathname, tab.href) ? 'page' : undefined}>
            {Icon && <Icon />}
            {t(tab.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
