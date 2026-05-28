import { render } from 'solid-js/web';
import { Show, createMemo, createResource, createSignal, For } from 'solid-js';
import '~/styles/global.css';
import { bootstrapTheme, createTheme } from '~/stores/theme';
import { applyBrandingToDocument, readBranding } from '~/stores/branding';
import {
  BrandMark,
  Button,
  EmptyState,
  FieldLabel,
  FileIcon,
  IconBack,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconFolder,
  IconLock,
  IconWarning,
  Input,
  Spinner,
  ThemeToggle,
  ToastProvider,
  useToast,
} from '~/ui';
import { previewKind } from '~/lib/fileKind';
import { formatAbsoluteDate, formatBytes } from '~/lib/format';
import type { ShareFilePayload } from '~/api/types';

bootstrapTheme();

function readSharePayload(): ShareFilePayload {
  if (typeof document === 'undefined') return {};
  const el = document.getElementById('file-data');
  if (!el) return {};
  try {
    return JSON.parse(el.textContent || '{}') as ShareFilePayload;
  } catch {
    return {};
  }
}

function ShareApp() {
  const branding = readBranding();
  const data = readSharePayload();
  const { theme, toggle } = createTheme();
  const toast = useToast();

  const token = window.location.pathname.split('/').filter(Boolean)[1] || '';

  applyBrandingToDocument(branding, data.name || data.folderName || '分享');

  const copyLink = async (extra = '') => {
    try {
      await navigator.clipboard.writeText(window.location.origin + '/s/' + token + extra);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div class="min-h-dvh flex flex-col bg-bg-base">
      <header class="border-b hairline px-4 sm:px-6 py-3 safe-pt">
        <div class="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <a href="/" class="inline-flex">
            <BrandMark branding={branding} size="sm" />
          </a>
          <ThemeToggle theme={theme()} onToggle={toggle} size="sm" />
        </div>
      </header>

      <main class="flex-1 px-4 sm:px-6 py-6">
        <div class="max-w-3xl mx-auto animate-slide-up">
          <Show when={data.error}>
            <ErrorView message={data.error!} />
          </Show>
          <Show when={data.needsPassword}>
            <PasswordGate isFolder={!!data.isFolder} />
          </Show>
          <Show when={!data.error && !data.needsPassword && data.isFolder}>
            <FolderView data={data} token={token} onCopyRoot={() => copyLink()} />
          </Show>
          <Show when={!data.error && !data.needsPassword && !data.isFolder && data.name}>
            <FileView data={data} token={token} onCopy={() => copyLink()} />
          </Show>
          <Show when={!data.error && !data.needsPassword && !data.isFolder && !data.name}>
            <ErrorView message="此分享链接可能已过期或被撤销。" />
          </Show>
        </div>
      </main>

      <footer class="px-4 py-4 text-center text-[11px] text-fg-subtle safe-pb">
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

function ErrorView(props: { message: string }) {
  return (
    <div class="surface border hairline rounded-xl px-6 py-12 text-center">
      <IconWarning size={28} class="text-fg-subtle mx-auto" />
      <h2 class="mt-3 text-base font-semibold">无法访问</h2>
      <p class="mt-1 text-[13px] text-fg-muted">{props.message}</p>
      <a href="/" class="inline-flex mt-5">
        <Button variant="secondary" size="sm" leadingIcon={<IconBack size={14} />}>
          返回首页
        </Button>
      </a>
    </div>
  );
}

function PasswordGate(props: { isFolder: boolean }) {
  const [password, setPassword] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!password() || submitting()) return;
    setSubmitting(true);
    setErr(null);
    try {
      const action = window.location.pathname + '/verify';
      const res = await fetch(action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: password() }),
        credentials: 'same-origin',
        redirect: 'follow',
      });
      if (res.redirected) {
        window.location.href = res.url;
        return;
      }
      if (res.ok) {
        window.location.reload();
        return;
      }
      setErr('密码错误');
    } catch {
      setErr('连接错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="surface border hairline rounded-xl px-6 py-8 max-w-sm mx-auto text-center">
      <div class="inline-flex h-12 w-12 items-center justify-center rounded-full bg-bg-inset text-fg-muted">
        <IconLock size={20} />
      </div>
      <h2 class="mt-3 text-base font-semibold">{props.isFolder ? '文件夹受密码保护' : '文件受密码保护'}</h2>
      <p class="mt-1 text-[13px] text-fg-muted">输入密码以查看{props.isFolder ? '文件夹' : '文件'}</p>
      <form onSubmit={submit} class="mt-5 text-left">
        <FieldLabel for="share-password" class="mb-1.5 sr-only">
          密码
        </FieldLabel>
        <Input
          id="share-password"
          type="password"
          placeholder="密码"
          required
          autofocus
          size="lg"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        <Show when={err()}>
          <p class="mt-2 text-[12px] text-danger">{err()}</p>
        </Show>
        <Button type="submit" variant="primary" size="lg" block class="mt-4" loading={submitting()}>
          解锁
        </Button>
      </form>
    </div>
  );
}

function FileView(props: { data: ShareFilePayload; token: string; onCopy: () => void }) {
  const previewUrl = `/s/${props.token}/preview`;
  const downloadUrl = `/s/${props.token}/download`;
  const kind = createMemo(() => previewKind(props.data.type, props.data.name));

  return (
    <div class="space-y-4">
      <div class="surface border hairline rounded-xl overflow-hidden">
        <PreviewSurface
          kind={kind()}
          src={previewUrl}
          name={props.data.name || ''}
          type={props.data.type || ''}
        />
      </div>

      <div class="surface border hairline rounded-xl px-4 py-4 sm:px-5">
        <div class="flex items-start gap-3">
          <FileIcon type={props.data.type} name={props.data.name} size="lg" rounded="md" />
          <div class="flex-1 min-w-0">
            <h1 class="text-[15px] font-semibold truncate" title={props.data.name}>
              {props.data.name}
            </h1>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted tabular">
              <span>{formatBytes(props.data.size)}</span>
              <span class="text-fg-subtle">·</span>
              <span>{formatAbsoluteDate(props.data.uploadedAt)}</span>
              <Show when={(props.data.downloads ?? 0) > 0}>
                <span class="text-fg-subtle">·</span>
                <span>{props.data.downloads} 次下载</span>
              </Show>
            </div>
          </div>
        </div>

        <div class="mt-4 flex flex-col-reverse sm:flex-row gap-2">
          <Button variant="secondary" size="md" leadingIcon={<IconCopy size={16} />} onClick={props.onCopy}>
            复制链接
          </Button>
          <a href={downloadUrl} class="block flex-1">
            <Button variant="primary" size="md" block leadingIcon={<IconDownload size={16} />}>
              下载
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}

function PreviewSurface(props: { kind: ReturnType<typeof previewKind>; src: string; name: string; type: string }) {
  if (props.kind === 'image') {
    return <img src={props.src} alt={props.name} class="w-full max-h-[70vh] object-contain bg-bg-inset" />;
  }
  if (props.kind === 'video') {
    return <video src={props.src} controls preload="metadata" class="w-full max-h-[70vh] bg-black" />;
  }
  if (props.kind === 'audio') {
    return (
      <div class="px-6 py-10 text-center">
        <FileIcon type={props.type} name={props.name} size="xl" rounded="lg" class="mb-4" />
        <audio src={props.src} controls class="w-full max-w-md mx-auto" />
      </div>
    );
  }
  if (props.kind === 'pdf') {
    return <iframe src={props.src} class="w-full h-[70vh] block" title="PDF preview" />;
  }
  if (props.kind === 'code' || props.kind === 'markdown') {
    return <CodeOrMarkdownPreview src={props.src} markdown={props.kind === 'markdown'} />;
  }
  return (
    <div class="px-6 py-12">
      <EmptyState
        icon={<FileIcon type={props.type} name={props.name} size="xl" rounded="lg" />}
        title="此文件类型不支持在线预览"
        description="点击下方“下载”按钮以获取文件"
      />
    </div>
  );
}

function CodeOrMarkdownPreview(props: { src: string; markdown: boolean }) {
  const [data] = createResource(() => props.src, async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to load preview');
    return res.text();
  });
  return (
    <Show
      when={!data.loading}
      fallback={
        <div class="px-6 py-12 flex items-center justify-center">
          <Spinner size={20} />
        </div>
      }
    >
      <Show when={!data.error} fallback={<div class="px-6 py-12 text-center text-danger text-sm">预览加载失败</div>}>
        <Show when={props.markdown} fallback={<pre class="code-body">{data() ?? ''}</pre>}>
          <div class="md-body p-5 max-h-[70vh] overflow-auto">
            <pre class="whitespace-pre-wrap font-mono text-[13px] leading-relaxed">{data() ?? ''}</pre>
          </div>
        </Show>
      </Show>
    </Show>
  );
}

function FolderView(props: { data: ShareFilePayload; token: string; onCopyRoot: () => void }) {
  const subpath = () => props.data.subpath || '';
  const segments = createMemo(() => (subpath() ? subpath().split('/') : []));

  const goTo = (idx: number | -1) => {
    if (idx === -1) {
      window.location.href = `/s/${props.token}`;
    } else {
      const next = segments().slice(0, idx + 1).join('/');
      window.location.href = `/s/${props.token}?path=${encodeURIComponent(next)}`;
    }
  };

  return (
    <div class="space-y-4">
      <div class="surface border hairline rounded-xl px-4 py-4 sm:px-5">
        <div class="flex items-start gap-3">
          <FileIcon asFolder size="lg" rounded="md" />
          <div class="flex-1 min-w-0">
            <h1 class="text-[15px] font-semibold truncate">
              {subpath() ? segments()[segments().length - 1] : props.data.folderName}
            </h1>
            <div class="mt-1 flex items-center gap-1 flex-wrap text-[12px]">
              <button
                class="text-fg-muted hover:text-fg hover:underline underline-offset-2"
                onClick={() => goTo(-1)}
              >
                {props.data.folderName}
              </button>
              <For each={segments()}>
                {(seg, i) => (
                  <>
                    <IconChevronRight size={11} class="text-fg-subtle" />
                    <Show
                      when={i() < segments().length - 1}
                      fallback={<span class="text-fg">{seg}</span>}
                    >
                      <button
                        class="text-fg-muted hover:text-fg hover:underline underline-offset-2"
                        onClick={() => goTo(i())}
                      >
                        {seg}
                      </button>
                    </Show>
                  </>
                )}
              </For>
            </div>
          </div>
          <Button variant="secondary" size="sm" leadingIcon={<IconCopy size={14} />} onClick={props.onCopyRoot}>
            复制
          </Button>
        </div>
      </div>

      <div class="surface border hairline rounded-xl overflow-hidden">
        <Show
          when={(props.data.subfolders?.length ?? 0) + (props.data.files?.length ?? 0) > 0}
          fallback={
            <EmptyState
              size="sm"
              icon={<IconFolder size={32} />}
              title="文件夹为空"
              description="此分享文件夹中暂无内容"
            />
          }
        >
          <ul class="divide-y hairline divide-line">
            <For each={props.data.subfolders ?? []}>
              {(sf) => {
                const relativePath = sf.slice((props.data.folder ?? '').length + 1);
                const sfName = sf.split('/').pop() || sf;
                return (
                  <li>
                    <a
                      href={`/s/${props.token}?path=${encodeURIComponent(relativePath)}`}
                      class="flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors"
                    >
                      <FileIcon asFolder size="sm" rounded="md" />
                      <span class="flex-1 truncate text-[14px]">{sfName}</span>
                      <IconChevronRight size={14} class="text-fg-subtle" />
                    </a>
                  </li>
                );
              }}
            </For>
            <For each={props.data.files ?? []}>
              {(f) => (
                <li class="flex items-center gap-3 px-4 py-3 hover:bg-bg-hover transition-colors">
                  <FileIcon type={f.type} name={f.name} size="sm" rounded="md" />
                  <div class="flex-1 min-w-0">
                    <div class="text-[14px] truncate" title={f.name}>
                      {f.name}
                    </div>
                    <div class="text-[11px] text-fg-muted tabular mt-0.5">{formatBytes(f.size)}</div>
                  </div>
                  <a
                    href={`/s/${props.token}/folder-download?fileId=${f.id}`}
                    class="inline-flex h-9 px-3 items-center justify-center gap-1.5 rounded-md text-[12px] text-brand border border-brand/30 hover:bg-brand-soft transition-colors tap tap-md"
                    aria-label="Download"
                  >
                    <IconDownload size={14} />
                    <span class="hidden sm:inline">下载</span>
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}

render(
  () => (
    <ToastProvider>
      <ShareApp />
    </ToastProvider>
  ),
  document.getElementById('app')!,
);
