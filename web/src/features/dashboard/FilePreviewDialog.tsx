import { Show, createMemo, createResource, type Component } from 'solid-js';
import { Dialog, FileIcon, Button, IconDownload, Spinner, EmptyState } from '~/ui';
import { previewKind } from '~/lib/fileKind';
import { formatBytes } from '~/lib/format';
import type { FileMeta } from '~/api/types';

export const FilePreviewDialog: Component<{
  file: FileMeta | null;
  onClose: () => void;
}> = (props) => {
  const open = () => props.file !== null;
  const file = () => props.file!;
  const previewUrl = () => `/api/files/${file().id}/preview`;
  const downloadUrl = () => (file().shareToken ? `/s/${file().shareToken}/download` : `/api/files/${file().id}/download`);
  const kind = createMemo(() => (props.file ? previewKind(props.file.type, props.file.name) : 'unsupported'));

  return (
    <Dialog
      open={open()}
      onClose={props.onClose}
      maxWidth="900px"
      title={
        <Show when={props.file}>
          <div class="flex items-center gap-2 min-w-0">
            <FileIcon type={file().type} name={file().name} size="xs" rounded="sm" />
            <span class="truncate">{file().name}</span>
            <span class="text-[11px] text-fg-subtle tabular shrink-0 ml-2">{formatBytes(file().size)}</span>
          </div>
        </Show>
      }
      footer={
        <Show when={props.file}>
          <a href={downloadUrl()} target="_blank" rel="noopener" class="inline-flex">
            <Button variant="secondary" size="sm" leadingIcon={<IconDownload size={14} />}>
              下载
            </Button>
          </a>
        </Show>
      }
      dense
    >
      <Show when={props.file}>
        <PreviewBody url={previewUrl()} kind={kind()} type={file().type} name={file().name} />
      </Show>
    </Dialog>
  );
};

const PreviewBody: Component<{ url: string; kind: ReturnType<typeof previewKind>; type: string; name: string }> = (props) => {
  if (props.kind === 'video') return <video src={props.url} controls autoplay class="w-full max-h-[70vh] bg-black rounded-md" />;
  if (props.kind === 'audio') {
    return (
      <div class="px-6 py-10 text-center">
        <FileIcon type={props.type} name={props.name} size="xl" rounded="lg" class="mb-4" />
        <audio src={props.url} controls autoplay class="w-full max-w-md mx-auto" />
      </div>
    );
  }
  if (props.kind === 'pdf') return <iframe src={props.url} class="w-full h-[70vh] block rounded-md" title="PDF" />;
  if (props.kind === 'code' || props.kind === 'markdown') return <CodePreview src={props.url} markdown={props.kind === 'markdown'} />;
  if (props.kind === 'image') return <img src={props.url} alt={props.name} class="w-full max-h-[70vh] object-contain bg-bg-inset rounded-md" />;
  return (
    <EmptyState
      icon={<FileIcon type={props.type} name={props.name} size="xl" rounded="lg" />}
      title="此文件类型不支持预览"
      description="请使用下方按钮下载查看"
      size="sm"
    />
  );
};

const CodePreview: Component<{ src: string; markdown: boolean }> = (props) => {
  const [data] = createResource(() => props.src, async (url) => {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to load preview');
    return res.text();
  });
  return (
    <Show
      when={!data.loading}
      fallback={
        <div class="flex items-center justify-center py-12">
          <Spinner size={20} />
        </div>
      }
    >
      <Show when={!data.error} fallback={<div class="text-sm text-danger text-center py-12">预览加载失败</div>}>
        <pre class="code-body rounded-md max-h-[70vh]">{data() ?? ''}</pre>
      </Show>
    </Show>
  );
};
