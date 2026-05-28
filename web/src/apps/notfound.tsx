import { render } from 'solid-js/web';
import '~/styles/global.css';
import { bootstrapTheme } from '~/stores/theme';
import { applyBrandingToDocument, readBranding } from '~/stores/branding';
import { BrandMark, Button, IconBack } from '~/ui';

bootstrapTheme();

function NotFoundApp() {
  const branding = readBranding();
  applyBrandingToDocument(branding, '页面未找到');

  return (
    <div class="min-h-dvh flex flex-col bg-bg-base">
      <header class="px-4 py-3 sm:px-6 border-b hairline safe-pt">
        <a href="/" class="inline-flex">
          <BrandMark branding={branding} size="sm" />
        </a>
      </header>

      <main class="flex-1 flex items-center justify-center px-4">
        <div class="text-center max-w-sm animate-slide-up">
          <p class="font-mono text-7xl sm:text-8xl font-semibold tracking-tight text-fg-subtle/70 leading-none">
            404
          </p>
          <h1 class="mt-5 text-lg font-semibold">页面未找到</h1>
          <p class="mt-1.5 text-[13px] text-fg-muted">
            你访问的页面不存在，或已被移除。
          </p>
          <div class="mt-6">
            <a href="/">
              <Button variant="primary" size="md" leadingIcon={<IconBack size={16} />}>
                返回首页
              </Button>
            </a>
          </div>
        </div>
      </main>

      <footer class="px-4 py-4 text-center text-[11px] text-fg-subtle">
        Powered by{' '}
        <a
          href="https://github.com/zqs1qiwan/cloudvault"
          target="_blank"
          rel="noopener"
          class="underline underline-offset-2 hover:text-fg-muted"
        >
          CloudVault
        </a>
      </footer>
    </div>
  );
}

render(() => <NotFoundApp />, document.getElementById('app')!);
