'use client';

import { Loader2, MapPin, Search } from 'lucide-react';
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
    <div className="relative w-full">
      <form onSubmit={submit} role="search" className="relative">
        {status === 'busy' ? (
          <Loader2 className="spin pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
        ) : (
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
        )}
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (status !== 'busy') setStatus('idle');
          }}
          placeholder={t('sit.search.placeholder')}
          aria-label={t('sit.search.placeholder')}
          className="field pl-9"
        />
      </form>
      {(results.length > 0 || status === 'empty' || status === 'error') && (
        <div
          role="listbox"
          className="map-card fade-in absolute left-0 right-0 top-full z-10 mt-1.5 overflow-hidden py-1"
        >
          {status === 'empty' && <Message text={t('sit.search.none')} />}
          {status === 'error' && <Message text={t('sit.unavailable')} />}
          {results.map((result) => (
            <button
              key={`${result.latitude},${result.longitude},${result.label}`}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => pick(result)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-[var(--color-ink)] transition-colors duration-100 hover:bg-[var(--color-surface)]"
            >
              <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]" />
              <span className="truncate">{result.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="px-3 py-2 text-[12px] text-[var(--color-muted)]">{text}</div>;
}
