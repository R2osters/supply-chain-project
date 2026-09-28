'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import type { GeocodeResponse } from '@/lib/intel';
import { useI18n } from '@/lib/i18n';

type Result = GeocodeResponse['results'][number];

/**
 * Place and coordinate search. Submitted, not searched on every keystroke: the keyless geocoders
 * behind it allow about one request per second for everyone, and type-ahead would spend that on
 * half-typed words.
 */
export function PlaceSearch({ onPick }: { onPick(result: Result): void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [status, setStatus] = useState<'idle' | 'busy' | 'empty' | 'error'>('idle');

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setStatus('busy');
    try {
      const response = await api<GeocodeResponse>(`/geocode?q=${encodeURIComponent(q)}&limit=5`);
      setResults(response.results);
      setStatus(response.results.length ? 'idle' : 'empty');
      if (response.results.length === 1) pick(response.results[0]);
    } catch {
      setStatus('error');
    }
  };

  const pick = (result: Result): void => {
    onPick(result);
    setResults([]);
  };

  return (
    <div className="relative w-[280px]">
      <form onSubmit={submit}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sit.search.placeholder')}
          aria-label={t('sit.search.placeholder')}
          className="w-full border border-[var(--color-hairline-bright)] bg-[color-mix(in_srgb,var(--color-void)_92%,transparent)] px-2.5 py-1.5 font-mono text-[0.6875rem] text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-signal)] focus:outline-none"
        />
      </form>
      {(results.length > 0 || status === 'empty' || status === 'error' || status === 'busy') && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 border border-[var(--color-hairline-bright)] bg-[var(--color-panel)]">
          {status === 'busy' && <Message text={t('sit.loading')} />}
          {status === 'empty' && <Message text={t('sit.search.none')} />}
          {status === 'error' && <Message text={t('sit.unavailable')} />}
          {results.map((result) => (
            <button
              key={`${result.latitude},${result.longitude},${result.label}`}
              onClick={() => pick(result)}
              className="block w-full truncate px-2.5 py-1.5 text-left text-[0.75rem] text-[var(--color-ink-dim)] hover:bg-[color-mix(in_srgb,var(--color-signal)_8%,transparent)] hover:text-[var(--color-ink)]"
            >
              {result.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="px-2.5 py-1.5 font-mono text-[0.625rem] text-[var(--color-ink-faint)]">{text}</div>;
}
