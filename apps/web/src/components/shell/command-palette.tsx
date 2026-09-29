'use client';

import { ArrowRight, CornerDownLeft, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import type { NavItem } from '@/lib/nav';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: NavItem['icon'] | typeof Search;
  run: () => void;
}

/**
 * ⌘K / "/" palette. Jumps to any module, or carries the typed text into the search of the
 * screen that owns that kind of object (a tracking number to Shipments, a SKU to Stocks…).
 */
export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: NavItem[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    const go = (href: string) => () => {
      router.push(href);
      onClose();
    };
    const modules: Command[] = items
      .filter((item) => !q || t(item.labelKey).toLowerCase().includes(q))
      .map((item) => ({
        id: item.href,
        label: t(item.labelKey),
        hint: t('shell.goTo'),
        icon: item.icon,
        run: go(item.href),
      }));
    if (!q) return modules;
    const searchable: Array<[string, NavItem['labelKey']]> = [
      ['/shipments', 'nav.shipments'],
      ['/maritime', 'nav.maritime'],
      ['/inventory', 'nav.inventory'],
    ];
    const searches: Command[] = searchable
      .filter(([href]) => items.some((item) => item.href === href))
      .map(([href, labelKey]) => ({
        id: `search:${href}`,
        label: t('shell.searchIn', { q: query.trim(), where: t(labelKey) }),
        icon: Search,
        run: go(`${href}?q=${encodeURIComponent(query.trim())}`),
      }));
    return [...modules, ...searches];
  }, [items, query, router, onClose, t]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, commands.length - 1)));
  }, [commands.length]);

  if (!open) return null;

  return (
    <div
      className="fade-in fixed inset-0 z-40 flex items-start justify-center bg-black/30 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.commands')}
        className="slide-up w-full max-w-[600px] overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] shadow-[var(--shadow-lg)]"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor((c) => Math.min(commands.length - 1, c + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            commands[cursor]?.run();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <label className="flex items-center gap-3 border-b border-[var(--color-line)] px-4">
          <Search className="h-4 w-4 text-[var(--color-muted)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('shell.search')}
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-[var(--color-dim)]"
            aria-controls="palette-list"
            aria-activedescendant={commands[cursor] ? `cmd-${cursor}` : undefined}
          />
          <span className="kbd">Esc</span>
        </label>
        <ul id="palette-list" role="listbox" className="m-0 max-h-[50vh] list-none overflow-y-auto p-2">
          {commands.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-[var(--color-muted)]">
              {t('shell.noMatch', { q: query })}
            </li>
          )}
          {commands.map((command, index) => {
            const Icon = command.icon;
            const active = index === cursor;
            return (
              <li
                key={command.id}
                id={`cmd-${index}`}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setCursor(index)}
                onClick={command.run}
                className={`flex cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 text-[13.5px] transition-colors duration-100 ${
                  active ? 'bg-[var(--color-accent)] text-[var(--color-accent-tx)]' : ''
                }`}
              >
                <Icon className={`h-4 w-4 ${active ? '' : 'text-[var(--color-muted)]'}`} />
                <span className="flex-1 truncate">{command.label}</span>
                {command.hint && (
                  <span className={`text-[12px] ${active ? 'opacity-70' : 'text-[var(--color-dim)]'}`}>
                    {command.hint}
                  </span>
                )}
                {active ? <CornerDownLeft className="h-3.5 w-3.5 opacity-70" /> : <ArrowRight className="h-3.5 w-3.5 opacity-0" />}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
