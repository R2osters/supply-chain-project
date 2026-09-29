"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Banner, Button } from "@/components/ui";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export interface SetupStatus {
  needsSetup: boolean;
  demoAvailable: boolean;
  demoAccounts: boolean;
}

/**
 * Whether this install still needs its first company. Only a desktop install starts empty; on a
 * server build, or if the endpoint is missing, the login form simply shows as before.
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api<SetupStatus>("/setup/status"),
    retry: false,
    staleTime: Infinity,
  });
}

interface FirstRunProps {
  demoAvailable: boolean;
  /** Called once the company exists, with the credentials to sign in with. */
  onCreated: (email: string, password: string) => Promise<void>;
  /** Called once the demo data is in, so the login form and demo accounts can take over. */
  onDemoLoaded: () => void;
}

const EMPTY_FORM = {
  companyName: "",
  companyCountry: "",
  firstName: "",
  lastName: "",
  email: "",
  password: "",
};

export function FirstRun({
  demoAvailable,
  onCreated,
  onDemoLoaded,
}: FirstRunProps) {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState<"create" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bind = (key: keyof typeof EMPTY_FORM) => ({
    value: form[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value })),
  });

  async function run(kind: "create" | "demo", action: () => Promise<void>) {
    setError(null);
    setBusy(kind);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("setup.failed"));
      setBusy(null);
    }
  }

  function create(event: React.FormEvent) {
    event.preventDefault();
    const body = {
      ...form,
      email: form.email.trim(),
      companyCountry: form.companyCountry.trim().toUpperCase(),
    };
    void run("create", async () => {
      await api("/auth/register", { method: "POST", body });
      await onCreated(body.email, body.password);
    });
  }

  function loadDemo() {
    void run("demo", async () => {
      await api("/setup/demo", { method: "POST" });
      onDemoLoaded();
    });
  }

  const input = "field !h-[42px] !text-[14px]";
  const label = "text-[12.5px] font-medium text-[var(--color-muted)]";

  return (
    <>
      <header className="flex flex-col gap-1">
        <h2 className="t-h2 m-0">{t("setup.title")}</h2>
        <p className="m-0 text-[13px] text-[var(--color-muted)]">
          {t("setup.subtitle")}
        </p>
      </header>

      <form onSubmit={create} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className={label}>{t("setup.company")}</span>
          <input
            className={input}
            required
            minLength={2}
            maxLength={120}
            autoComplete="organization"
            {...bind("companyName")}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={label}>{t("setup.country")}</span>
          <input
            className={input}
            required
            minLength={2}
            maxLength={60}
            autoComplete="country"
            placeholder="FR"
            {...bind("companyCountry")}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={label}>{t("setup.firstName")}</span>
            <input
              className={input}
              required
              maxLength={80}
              autoComplete="given-name"
              {...bind("firstName")}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className={label}>{t("setup.lastName")}</span>
            <input
              className={input}
              required
              maxLength={80}
              autoComplete="family-name"
              {...bind("lastName")}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className={label}>{t("setup.email")}</span>
          <input
            className={input}
            type="email"
            required
            autoComplete="username"
            {...bind("email")}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className={label}>{t("setup.password")}</span>
          <input
            className={input}
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            {...bind("password")}
          />
          <span className="text-[12px] text-[var(--color-dim)]">
            {t("setup.passwordHint")}
          </span>
        </label>

        {error && (
          <Banner tone="alert" title={t("setup.failed")}>
            {error}
          </Banner>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy === "create"}
          disabled={busy !== null}
          className="w-full"
        >
          {busy === "create" ? t("setup.creating") : t("setup.create")}
        </Button>
      </form>

      {demoAvailable && (
        <div className="flex flex-col gap-2 border-t border-[var(--color-line)] pt-5">
          <span className="t-label">{t("setup.or")}</span>
          <Button
            size="lg"
            loading={busy === "demo"}
            disabled={busy !== null}
            onClick={loadDemo}
            className="w-full"
          >
            {busy === "demo" ? t("setup.demoLoading") : t("setup.demo")}
          </Button>
          <p className="m-0 text-[12px] leading-relaxed text-[var(--color-dim)]">
            {t("setup.demoHint")}
          </p>
        </div>
      )}
    </>
  );
}
