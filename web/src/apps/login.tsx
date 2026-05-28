import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import '~/styles/global.css';
import { bootstrapTheme, createTheme } from '~/stores/theme';
import { applyBrandingToDocument, readBranding } from '~/stores/branding';
import { BrandMark, Button, FieldLabel, Input, ThemeToggle, ToastProvider, useToast } from '~/ui';
import { login } from '~/api';

bootstrapTheme();

function LoginApp() {
  const branding = readBranding();
  applyBrandingToDocument(branding, '登录');
  const { theme, toggle } = createTheme();
  const toast = useToast();

  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await login(password());
      if (!res.ok) {
        setError(res.error || '密码错误');
        toast.error(res.error || '密码错误');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="min-h-dvh flex flex-col bg-bg-base">
      <header class="px-4 py-3 sm:px-6 flex items-center justify-between safe-pt">
        <BrandMark branding={branding} size="sm" showName={false} />
        <ThemeToggle theme={theme()} onToggle={toggle} size="sm" />
      </header>

      <main class="flex-1 flex items-center justify-center px-4">
        <div class="w-full max-w-[380px] animate-slide-up">
          <div class="text-center mb-7">
            <BrandMark branding={branding} size="lg" showName={false} class="mb-4" />
            <h1 class="text-[22px] font-semibold tracking-tight">{branding.siteName}</h1>
            <p class="mt-1 text-[13px] text-fg-muted">输入密码以访问管理后台</p>
          </div>

          <form onSubmit={submit} class="surface border hairline rounded-xl p-5 shadow-soft">
            {error() && (
              <div
                class="mb-4 px-3 py-2 rounded-md border border-danger/30 bg-danger/8 text-danger text-[13px]"
                role="alert"
              >
                {error()}
              </div>
            )}

            <FieldLabel for="password" class="mb-1.5">
              密码
            </FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autofocus
              autocomplete="current-password"
              size="lg"
              placeholder="••••••••"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />

            <Button type="submit" variant="primary" size="lg" block class="mt-5" loading={submitting()}>
              登录
            </Button>
          </form>

          <p class="mt-6 text-center text-[11px] text-fg-subtle">
            Powered by{' '}
            <a
              href="https://github.com/zqs1qiwan/cloudvault"
              target="_blank"
              rel="noopener"
              class="underline underline-offset-2 hover:text-fg-muted"
            >
              CloudVault
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}

render(
  () => (
    <ToastProvider>
      <LoginApp />
    </ToastProvider>
  ),
  document.getElementById('app')!,
);
