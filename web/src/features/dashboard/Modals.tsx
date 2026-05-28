import {
  Show,
  createEffect,
  createResource,
  createSignal,
  For,
  type Component,
} from 'solid-js';
import {
  Button,
  Dialog,
  FieldLabel,
  IconCopy,
  IconFolder,
  IconHome,
  IconLink,
  IconLock,
  Input,
  Spinner,
  Toggle,
} from '~/ui';
import {
  createFolderShareLink as apiCreateFolderShareLink,
  createShare,
  getFolderShareLink,
  getSettings,
  revokeFolderShareLink as apiRevokeFolderShareLink,
  revokeShare,
  saveSettings,
} from '~/api';
import type { FileMeta, SiteSettings } from '~/api/types';
import { useToast } from '~/ui';
import { cn } from '~/lib/cn';

// ─── New Folder ──────────────────────────────────────────────────────────

export const NewFolderDialog: Component<{
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
}> = (props) => {
  const [name, setName] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    if (props.open) setName('');
  });

  const submit = async () => {
    if (!name().trim() || submitting()) return;
    setSubmitting(true);
    try {
      await props.onCreate(name().trim());
      props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="新建文件夹"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={submitting()} onClick={submit}>
            创建
          </Button>
        </>
      }
    >
      <FieldLabel class="mb-1.5">文件夹名称</FieldLabel>
      <Input
        autofocus
        size="md"
        placeholder="例如：照片"
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
    </Dialog>
  );
};

// ─── Rename File / Folder ────────────────────────────────────────────────

export const RenameDialog: Component<{
  open: boolean;
  onClose: () => void;
  current: string;
  title?: string;
  hint?: string;
  onConfirm: (newName: string) => Promise<void>;
}> = (props) => {
  const [name, setName] = createSignal(props.current);
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    if (props.open) setName(props.current);
  });

  const submit = async () => {
    if (!name().trim() || submitting() || name().trim() === props.current) {
      props.onClose();
      return;
    }
    setSubmitting(true);
    try {
      await props.onConfirm(name().trim());
      props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title ?? '重命名'}
      description={props.hint}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={submitting()} onClick={submit}>
            重命名
          </Button>
        </>
      }
    >
      <Input
        autofocus
        size="md"
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
    </Dialog>
  );
};

// ─── Confirm Delete ──────────────────────────────────────────────────────

export const ConfirmDialog: Component<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  variant?: 'danger' | 'primary';
  onConfirm: () => Promise<void>;
}> = (props) => {
  const [submitting, setSubmitting] = createSignal(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await props.onConfirm();
      props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button
            variant={props.variant === 'danger' ? 'danger' : 'primary'}
            size="sm"
            loading={submitting()}
            onClick={submit}
          >
            {props.confirmLabel ?? (props.variant === 'danger' ? '删除' : '确认')}
          </Button>
        </>
      }
    >
      <p class="text-[13px] text-fg-muted">{props.description}</p>
    </Dialog>
  );
};

// ─── Move Files ──────────────────────────────────────────────────────────

export const MoveDialog: Component<{
  open: boolean;
  onClose: () => void;
  fileIds: string[];
  folders: { name: string }[];
  onMove: (ids: string[], target: string) => Promise<number>;
}> = (props) => {
  const [target, setTarget] = createSignal('root');
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    if (props.open) setTarget('root');
  });

  const submit = async () => {
    if (submitting()) return;
    setSubmitting(true);
    try {
      await props.onMove(props.fileIds, target());
      props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="移动到…"
      description={`将移动 ${props.fileIds.length} 个文件`}
      maxWidth="480px"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={submitting()} onClick={submit}>
            移动
          </Button>
        </>
      }
    >
      <div class="surface-inset border hairline rounded-lg max-h-72 overflow-y-auto p-1.5">
        <button
          type="button"
          onClick={() => setTarget('root')}
          class={cn(
            'flex items-center gap-2 w-full h-9 px-2 rounded-md text-[13.5px] hover:bg-bg-hover',
            target() === 'root' ? 'bg-brand-soft text-brand' : 'text-fg-muted',
          )}
        >
          <IconHome size={15} />
          <span>Home</span>
        </button>
        <For each={props.folders}>
          {(f) => {
            const depth = f.name.split('/').length - 1;
            return (
              <button
                type="button"
                onClick={() => setTarget(f.name)}
                style={{ 'padding-left': `${8 + depth * 14}px` }}
                class={cn(
                  'flex items-center gap-2 w-full h-9 pr-2 rounded-md text-[13.5px] hover:bg-bg-hover',
                  target() === f.name ? 'bg-brand-soft text-brand' : 'text-fg-muted',
                )}
              >
                <IconFolder size={14} class="shrink-0" />
                <span class="truncate">{f.name.split('/').pop()}</span>
              </button>
            );
          }}
        </For>
      </div>
    </Dialog>
  );
};

// ─── Share File Dialog ───────────────────────────────────────────────────

export const ShareFileDialog: Component<{
  file: FileMeta | null;
  onClose: () => void;
  /** Updates store after the share token is created/revoked. */
  onChange: () => void;
}> = (props) => {
  const open = () => props.file !== null;
  const toast = useToast();
  const [password, setPassword] = createSignal('');
  const [days, setDays] = createSignal(0);
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    if (open()) {
      setPassword('');
      setDays(0);
    }
  });

  const create = async () => {
    if (!props.file || submitting()) return;
    setSubmitting(true);
    try {
      const res = await createShare({
        fileId: props.file.id,
        password: password() || undefined,
        expiresInDays: days() > 0 ? days() : undefined,
      });
      toast.success('分享链接已创建');
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/s/${res.token}`);
        toast.info('链接已复制');
      } catch {
        /* ignore */
      }
      props.onChange();
      props.onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建分享失败');
    } finally {
      setSubmitting(false);
    }
  };

  const revoke = async () => {
    if (!props.file) return;
    try {
      await revokeShare(props.file.id);
      toast.success('已撤销分享');
      props.onChange();
      props.onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败');
    }
  };

  const copyExisting = async () => {
    if (!props.file?.shareToken) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${props.file.shareToken}`);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog
      open={open()}
      onClose={props.onClose}
      title={<span class="inline-flex items-center gap-2"><IconLink size={15} /> 分享文件</span>}
      description={props.file?.name}
      maxWidth="480px"
    >
      <Show
        when={props.file?.shareToken}
        fallback={
          <div class="space-y-3">
            <div>
              <FieldLabel class="mb-1.5">密码（可选）</FieldLabel>
              <Input
                type="password"
                placeholder="留空表示不需要密码"
                value={password()}
                onInput={(e) => setPassword(e.currentTarget.value)}
                leadingIcon={<IconLock size={14} />}
              />
            </div>
            <div>
              <FieldLabel class="mb-1.5" hint="0 表示永不过期">
                有效期（天数）
              </FieldLabel>
              <Input
                type="number"
                min="0"
                placeholder="0"
                value={days()}
                onInput={(e) => setDays(Number(e.currentTarget.value) || 0)}
              />
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={props.onClose}>
                取消
              </Button>
              <Button variant="primary" size="sm" loading={submitting()} onClick={create}>
                创建链接
              </Button>
            </div>
          </div>
        }
      >
        <div class="space-y-3">
          <div class="flex gap-2">
            <Input readonly value={`${window.location.origin}/s/${props.file?.shareToken}`} />
            <Button variant="primary" size="md" leadingIcon={<IconCopy size={14} />} onClick={copyExisting}>
              复制
            </Button>
          </div>
          <div class="flex items-center justify-between text-[12px] text-fg-muted">
            <span>{props.file?.downloads ?? 0} 次下载</span>
            <Button variant="danger" size="xs" onClick={revoke}>
              撤销链接
            </Button>
          </div>
        </div>
      </Show>
    </Dialog>
  );
};

// ─── Folder Share Link Dialog ────────────────────────────────────────────

export const FolderShareLinkDialog: Component<{
  folder: string | null;
  onClose: () => void;
}> = (props) => {
  const open = () => props.folder !== null;
  const toast = useToast();

  const [info, { mutate: setInfo, refetch }] = createResource(
    () => props.folder,
    async (folder) => (folder ? getFolderShareLink(folder) : null),
  );

  const [password, setPassword] = createSignal('');
  const [days, setDays] = createSignal(0);
  const [submitting, setSubmitting] = createSignal(false);

  createEffect(() => {
    if (open()) {
      setPassword('');
      setDays(0);
      refetch();
    }
  });

  const create = async () => {
    if (!props.folder || submitting()) return;
    setSubmitting(true);
    try {
      const res = await apiCreateFolderShareLink({
        folder: props.folder,
        password: password() || undefined,
        expiresInDays: days() > 0 ? days() : undefined,
      });
      toast.success('文件夹分享链接已创建');
      setInfo({ token: res.token, hasPassword: res.hasPassword, expiresAt: res.expiresAt });
      try {
        await navigator.clipboard.writeText(`${window.location.origin}/s/${res.token}`);
        toast.info('链接已复制');
      } catch {
        /* ignore */
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const revoke = async () => {
    if (!props.folder) return;
    try {
      await apiRevokeFolderShareLink(props.folder);
      toast.success('已撤销链接');
      setInfo(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '撤销失败');
    }
  };

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/s/${token}`);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog
      open={open()}
      onClose={props.onClose}
      title={<span class="inline-flex items-center gap-2"><IconLink size={15} /> 文件夹分享链接</span>}
      description={props.folder ?? undefined}
      maxWidth="480px"
    >
      <Show when={!info.loading} fallback={<div class="py-6 flex justify-center"><Spinner /></div>}>
        <Show
          when={info()?.token}
          fallback={
            <div class="space-y-3">
              <div>
                <FieldLabel class="mb-1.5">密码（可选）</FieldLabel>
                <Input
                  type="password"
                  placeholder="留空表示不需要密码"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                  leadingIcon={<IconLock size={14} />}
                />
              </div>
              <div>
                <FieldLabel class="mb-1.5" hint="0 表示永不过期">
                  有效期（天数）
                </FieldLabel>
                <Input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={days()}
                  onInput={(e) => setDays(Number(e.currentTarget.value) || 0)}
                />
              </div>
              <div class="flex justify-end gap-2 pt-2">
                <Button variant="ghost" size="sm" onClick={props.onClose}>
                  取消
                </Button>
                <Button variant="primary" size="sm" loading={submitting()} onClick={create}>
                  创建链接
                </Button>
              </div>
            </div>
          }
        >
          <div class="space-y-3">
            <div class="flex gap-2">
              <Input readonly value={`${window.location.origin}/s/${info()!.token}`} />
              <Button
                variant="primary"
                size="md"
                leadingIcon={<IconCopy size={14} />}
                onClick={() => copy(info()!.token!)}
              >
                复制
              </Button>
            </div>
            <div class="flex items-center justify-between text-[12px] text-fg-muted">
              <div class="flex items-center gap-3">
                <Show when={info()!.hasPassword}>
                  <span class="inline-flex items-center gap-1">
                    <IconLock size={12} /> 密码保护
                  </span>
                </Show>
                <Show when={info()!.expiresAt}>
                  <span>到期：{new Date(info()!.expiresAt!).toLocaleDateString()}</span>
                </Show>
              </div>
              <Button variant="danger" size="xs" onClick={revoke}>
                撤销链接
              </Button>
            </div>
          </div>
        </Show>
      </Show>
    </Dialog>
  );
};

// ─── Settings ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: SiteSettings = {
  guestPageEnabled: false,
  showLoginButton: true,
  siteName: 'CloudVault',
  siteIconUrl: '',
};

export const SettingsDialog: Component<{
  open: boolean;
  onClose: () => void;
  onSaved: (settings: SiteSettings) => void;
}> = (props) => {
  const toast = useToast();
  const [settings, setSettings] = createSignal<SiteSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      setLoading(true);
      getSettings()
        .then(setSettings)
        .catch(() => setSettings(DEFAULT_SETTINGS))
        .finally(() => setLoading(false));
    }
  });

  const save = async () => {
    setSaving(true);
    try {
      const next = await saveSettings(settings());
      toast.success('设置已保存');
      props.onSaved(next);
      props.onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof SiteSettings>(k: K, v: SiteSettings[K]) =>
    setSettings({ ...settings(), [k]: v });

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title="站点设置"
      maxWidth="480px"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving()} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <Show
        when={!loading()}
        fallback={
          <div class="py-8 flex justify-center">
            <Spinner />
          </div>
        }
      >
        <div class="space-y-4">
          <div>
            <FieldLabel class="mb-1.5" hint="显示在头部、标题与公开页面">
              站点名称
            </FieldLabel>
            <Input
              maxLength={50}
              placeholder="CloudVault"
              value={settings().siteName}
              onInput={(e) => update('siteName', e.currentTarget.value)}
            />
          </div>

          <div>
            <FieldLabel class="mb-1.5" hint="留空使用默认云朵图标">
              图标 URL
            </FieldLabel>
            <Input
              type="url"
              placeholder="https://example.com/logo.png"
              value={settings().siteIconUrl}
              onInput={(e) => update('siteIconUrl', e.currentTarget.value)}
            />
            <Show when={settings().siteIconUrl}>
              <div class="mt-2 flex items-center gap-2">
                <div class="w-10 h-10 rounded-md overflow-hidden bg-bg-inset">
                  <img
                    src={settings().siteIconUrl}
                    alt=""
                    class="w-full h-full object-contain"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.opacity = '0.3';
                    }}
                  />
                </div>
                <span class="text-[11px] text-fg-subtle">预览</span>
              </div>
            </Show>
          </div>

          <div class="pt-3 border-t hairline space-y-3">
            <ToggleRow
              title="启用访客页面"
              hint="在首页公开展示已分享的文件"
              checked={settings().guestPageEnabled}
              onChange={(v) => update('guestPageEnabled', v)}
            />
            <Show when={settings().guestPageEnabled}>
              <ToggleRow
                title="显示登录按钮"
                hint="在访客页面右上角展示「登录」"
                checked={settings().showLoginButton}
                onChange={(v) => update('showLoginButton', v)}
              />
            </Show>
          </div>
        </div>
      </Show>
    </Dialog>
  );
};

const ToggleRow: Component<{
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = (props) => (
  <div class="flex items-center justify-between gap-4">
    <div class="min-w-0">
      <p class="text-[13.5px] font-medium">{props.title}</p>
      {props.hint && <p class="mt-0.5 text-[12px] text-fg-muted">{props.hint}</p>}
    </div>
    <Toggle checked={props.checked} onChange={props.onChange} label={props.title} />
  </div>
);
