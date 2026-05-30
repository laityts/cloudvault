import { For, Show, createEffect, createResource, createSignal, type Component } from 'solid-js';
import { Button, Dialog, Spinner, useToast } from '~/ui';
import { deleteFiles, listDuplicates } from '~/api';
import { formatBytes } from '~/lib/format';

export interface DuplicatesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after successful deletion so the caller can refresh files / stats. */
  onDeleted?: () => void;
}

export const DuplicatesDialog: Component<DuplicatesDialogProps> = (props) => {
  const toast = useToast();

  const [data, { refetch }] = createResource(
    () => props.open,
    async (open) => (open ? (await listDuplicates()).groups : []),
  );

  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal(false);

  // 默认勾选除最早一条外的所有副本（后端已按 uploaded_at 升序，files[0] 即最早）。
  createEffect(() => {
    const groups = data();
    if (!groups || groups.length === 0) {
      setSelected(new Set<string>());
      return;
    }
    const next = new Set<string>();
    for (const g of groups) {
      for (let i = 1; i < g.files.length; i++) {
        next.add(g.files[i]!.id);
      }
    }
    setSelected(next);
  });

  const totalDupCount = () => {
    const groups = data();
    if (!groups) return 0;
    let n = 0;
    for (const g of groups) n += Math.max(0, g.files.length - 1);
    return n;
  };

  const toggle = (id: string) => {
    const next = new Set(selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleDelete = async () => {
    const ids = Array.from(selected());
    if (ids.length === 0) return;
    if (!confirm(`确定删除 ${ids.length} 个重复副本？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await deleteFiles(ids);
      toast.success(`已删除 ${ids.length} 个重复副本`);
      props.onDeleted?.();
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="清理重复内容"
      description="按 SHA-256 分组，默认保留最早上传的一份。"
      maxWidth="640px"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy()}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy()}
            disabled={busy() || selected().size === 0}
            onClick={handleDelete}
          >
            删除选中（{selected().size}）
          </Button>
        </>
      }
    >
      <Show when={data.loading}>
        <div class="flex items-center justify-center py-8 text-fg-muted gap-2">
          <Spinner /> <span class="text-sm">加载中…</span>
        </div>
      </Show>

      <Show when={!data.loading && data.error}>
        <div class="text-fg-muted py-6 text-center text-sm">
          加载失败：{(data.error as Error)?.message || '未知错误'}
          <div class="mt-2">
            <button class="text-brand hover:underline" onClick={() => refetch()}>
              重试
            </button>
          </div>
        </div>
      </Show>

      <Show when={!data.loading && !data.error && data() && data()!.length === 0}>
        <div class="py-8 text-center text-sm text-fg-muted">仓库中没有重复内容。</div>
      </Show>

      <Show when={!data.loading && data() && data()!.length > 0}>
        <p class="text-xs text-fg-muted mb-3 tabular">
          发现 {data()!.length} 组重复 · 可删除 {totalDupCount()} 个副本
        </p>
        <div class="space-y-3">
          <For each={data()!}>
            {(group) => (
              <div class="border hairline rounded-md p-2.5">
                <div class="text-[11px] text-fg-subtle mb-1.5 tabular truncate">
                  SHA-256: {group.sha256.slice(0, 16)}… · {group.files.length} 个副本
                </div>
                <For each={group.files}>
                  {(f, i) => (
                    <label
                      class="flex items-center gap-2 py-1 cursor-pointer text-sm select-none"
                      title={`${f.folder}/${f.name}`}
                    >
                      <input
                        type="checkbox"
                        class="shrink-0"
                        checked={selected().has(f.id)}
                        onChange={() => toggle(f.id)}
                      />
                      <span class={i() === 0 ? 'text-fg-muted truncate' : 'truncate'}>
                        {f.folder === 'root' ? '' : `${f.folder}/`}
                        {f.name}
                      </span>
                      <span class="ml-auto shrink-0 text-[11px] text-fg-subtle tabular">
                        {formatBytes(f.size)}
                        <Show when={i() === 0}>
                          <span class="ml-2">最早 · 建议保留</span>
                        </Show>
                      </span>
                    </label>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Dialog>
  );
};
