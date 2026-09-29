'use client';

import { Check, CircleCheck, Copy } from 'lucide-react';
import { useRef, useState } from 'react';
import { Banner, Button } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { passwordGroups } from '@/lib/user-roles';

/**
 * A temporary password, shown this once. The API keeps only its hash, so once this panel is
 * closed the only way to a new one is another reset. Shown in groups of four for reading it out;
 * the groups are spacing, not characters, so a manual copy still gives the exact password.
 */
export function OneTimePassword({
  title,
  email,
  password,
  onDone,
}: {
  title: string;
  email: string;
  password: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'refused'>('idle');
  const codeRef = useRef<HTMLElement>(null);

  /** Selects the password on screen: the legacy copy path needs it, and Ctrl+C works after. */
  function selectPassword(): Selection | null {
    const node = codeRef.current;
    const selection = window.getSelection();
    if (!node || !selection) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      setCopy('copied');
      return;
    } catch {
      // Some webviews refuse the async clipboard; the older selection copy often still works.
    }
    const selection = selectPassword();
    let copied = false;
    try {
      copied = selection !== null && document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (copied) selection?.removeAllRanges();
    // Refused: the password stays selected on screen, ready for Ctrl+C.
    setCopy(copied ? 'copied' : 'refused');
  }

  return (
    <div className="flex flex-col gap-5">
      <Banner tone="ok" icon={CircleCheck} title={title}>
        {t('users.secret.explain')}
      </Banner>

      <div className="flex flex-col gap-2">
        <span className="t-label">{t('users.secret.label')}</span>
        <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] px-4 py-3">
          <code ref={codeRef} className="t-data select-all break-all text-[20px] font-medium text-[var(--color-ink)]">
            {passwordGroups(password).map((group, index) => (
              <span key={index} className="mr-[0.45em] last:mr-0">
                {group}
              </span>
            ))}
          </code>
          <Button size="sm" icon={copy === 'copied' ? Check : Copy} onClick={() => void copyPassword()} className="ml-auto">
            {copy === 'copied' ? t('users.secret.copied') : t('users.secret.copy')}
          </Button>
        </div>
        <span className="t-data text-[12px] text-[var(--color-muted)]">{t('users.secret.signIn', { email })}</span>
        {copy === 'refused' && <span className="text-[12px] text-[var(--color-warn)]">{t('users.secret.copyFailed')}</span>}
      </div>

      <p className="m-0 text-[12.5px] leading-relaxed text-[var(--color-muted)]">{t('users.secret.once')}</p>

      <div>
        <Button variant="primary" onClick={onDone}>
          {t('users.secret.done')}
        </Button>
      </div>
    </div>
  );
}
