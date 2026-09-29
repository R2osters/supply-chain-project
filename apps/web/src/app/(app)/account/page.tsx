'use client';

import { KeyRound, UserRound } from 'lucide-react';
import { PasswordChangeForm } from '@/components/account/password-change';
import { useToast } from '@/components/toast';
import { Facts, PageHeader, Panel } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useI18n, type TranslationKey } from '@/lib/i18n';

/**
 * Mon mot de passe: every signed-in user can change their own password here. The API signs out
 * their other sessions; this one continues (see AuthProvider.changePassword).
 */
export default function AccountPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const toast = useToast();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader kicker={t('account.kicker')} title={t('account.title')} description={t('account.description')} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel icon={KeyRound} title={t('account.title')}>
          <div className="max-w-[520px] px-5 pb-5 pt-2">
            <PasswordChangeForm onChanged={() => toast.show({ tone: 'success', message: t('account.changed') })} />
          </div>
        </Panel>
        {user && (
          <Panel icon={UserRound} title={t('account.profile')}>
            <div className="px-5 pb-5 pt-2">
              <Facts
                columns={1}
                items={[
                  [t('md.f.name'), `${user.firstName} ${user.lastName}`.trim()],
                  [t('account.email'), <span key="email" className="t-data">{user.email}</span>],
                  [t('users.f.role'), t(`users.role.${user.role}` as TranslationKey)],
                ]}
              />
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
