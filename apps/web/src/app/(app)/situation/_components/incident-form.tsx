'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import type { Exposure, Hazard, HazardSeverity } from '@/lib/intel';
import { useFormat, useI18n } from '@/lib/i18n';
import { Button, ErrorNote, Panel } from '@/components/ui';
import { useToast } from '@/components/toast';
import { SUBJECT_KEY } from './exposure-panel';
import { KIND_KEY, SEVERITY_KEY } from './hazard-kind';

/** The two incident types an external hazard maps to (POST /incidents, `type`). */
type IncidentType = 'WEATHER' | 'OTHER';
const SEVERITIES: HazardSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Files an incident from a hazard (POST /incidents). Everything is prefilled from the signal —
 * title, type, severity, a description that cites the source and the exposed assets — and the
 * operator edits before sending: the hazard is a hint, the incident is their statement.
 */
export function IncidentForm({
  hazard,
  exposed,
  onBack,
  onCreated,
}: {
  hazard: Hazard;
  exposed: Exposure[];
  onBack(): void;
  onCreated(): void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLInputElement | null>(null);

  const [title, setTitle] = useState(hazard.title.slice(0, 200));
  const [type, setType] = useState<IncidentType>(
    hazard.kind === 'CYCLONE' || hazard.kind === 'SEVERE_WEATHER' ? 'WEATHER' : 'OTHER',
  );
  const [severity, setSeverity] = useState<HazardSeverity>(hazard.severity);
  const [description, setDescription] = useState(() =>
    [
      `${t(KIND_KEY[hazard.kind])} — ${hazard.title}`,
      t('sit.v3.incident.descSource', {
        source: hazard.source,
        when: fmt.dateTime(hazard.observedAt),
        radius: fmt.num(hazard.radiusKm, 0),
      }),
      `${hazard.latitude.toFixed(3)}, ${hazard.longitude.toFixed(3)}`,
      exposed.length > 0
        ? `${t('sit.v3.detail.exposed')}: ${exposed
            .map((item) => `${item.subjectLabel} (${t(SUBJECT_KEY[item.subjectType])}, ${fmt.num(item.distanceKm, 0)} km)`)
            .join('; ')}`
        : null,
      hazard.url,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000),
  );

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; title: string }>('/incidents', {
        method: 'POST',
        body: {
          type,
          title: title.trim(),
          description: description.trim(),
          severity,
          latitude: hazard.latitude,
          longitude: hazard.longitude,
        },
      }),
    onSuccess: (incident) => {
      void queryClient.invalidateQueries({ queryKey: ['incidents'] });
      toast.show({
        tone: 'success',
        message: t('sit.v3.incident.created', { title: incident.title }),
        action: { label: t('sit.v3.incident.open'), onClick: () => router.push('/incidents') },
      });
      onCreated();
    },
  });

  const titleValid = title.trim().length >= 3;
  const descriptionValid = description.trim().length >= 3;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (titleValid && descriptionValid && !create.isPending) create.mutate();
  };

  return (
    <Panel
      icon={FilePlus2}
      title={t('sit.v3.incident.title')}
      actions={
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
          {t('sit.v3.incident.back')}
        </Button>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4 px-5 pb-5 pt-2" noValidate>
        <p className="m-0 text-[12.5px] text-[var(--color-muted)]">{t('sit.v3.incident.hint')}</p>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--color-muted)]">{t('sit.v3.incident.fieldTitle')}</span>
          <input
            ref={titleRef}
            className="field"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={!titleValid || undefined}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12px] text-[var(--color-muted)]">{t('inc.type')}</span>
            <select className="field" value={type} onChange={(event) => setType(event.target.value as IncidentType)}>
              <option value="WEATHER">{t('sit.v3.incident.typeWEATHER')}</option>
              <option value="OTHER">{t('sit.v3.incident.typeOTHER')}</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[12px] text-[var(--color-muted)]">{t('inc.severity')}</span>
            <select
              className="field"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as HazardSeverity)}
            >
              {SEVERITIES.map((option) => (
                <option key={option} value={option}>
                  {t(SEVERITY_KEY[option])}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--color-muted)]">{t('inc.what')}</span>
          <textarea
            className="field t-data min-h-[160px] resize-y text-[12px] leading-relaxed"
            value={description}
            maxLength={4000}
            onChange={(event) => setDescription(event.target.value)}
            aria-invalid={!descriptionValid || undefined}
          />
        </label>

        {create.isError && <ErrorNote error={create.error} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            icon={FilePlus2}
            loading={create.isPending}
            disabled={!titleValid || !descriptionValid}
          >
            {create.isPending ? t('sit.v3.incident.creating') : t('sit.v3.incident.submit')}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
