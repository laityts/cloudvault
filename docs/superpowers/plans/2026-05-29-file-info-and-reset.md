# 文件信息展示与数据重置功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现文件信息展示（含 SHA-1/SHA-256 哈希）和系统数据重置两个功能。

**Architecture:** 后端新增 GET /api/files/:id/info 和 POST /api/admin/reset-all 端点；哈希值延迟计算并缓存到 D1；前端新增 FileInfoDialog 组件并增强 SettingsDialog 危险区域。

**Tech Stack:** Cloudflare Workers, R2, D1, SolidJS, TypeScript, Tailwind CSS

---

## Task 1: 实现哈希计算工具 src/utils/hash.ts

**Files:**
- Create: `src/utils/hash.ts`

- [ ] **Step 1: 创建 src/utils/hash.ts 文件**

```typescript
/**
 * 流式计算 ReadableStream 的 SHA-1 和 SHA-256 哈希值。
 * 使用 stream.tee() 复制流，并行计算两个哈希。
 */
export async function computeHashes(
  stream: ReadableStream<Uint8Array>,
): Promise<{ sha1: string; sha256: string }> {
  const [stream1, stream2] = stream.tee();
  const [sha1, sha256] = await Promise.all([
    computeSingleHash(stream1, 'SHA-1'),
    computeSingleHash(stream2, 'SHA-256'),
  ]);
  return { sha1, sha256 };
}

async function computeSingleHash(
  stream: ReadableStream<Uint8Array>,
  algorithm: 'SHA-1' | 'SHA-256',
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }

  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  const hashBuffer = await crypto.subtle.digest(algorithm, buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

- [ ] **Step 2: 提交**

```bash
git add src/utils/hash.ts
git commit -m "feat(utils): 添加流式 SHA-1/SHA-256 哈希计算工具"
```

---

## Task 2: 实现 GET /api/files/:id/info 端点

**Files:**
- Modify: `src/api/files.ts`

- [ ] **Step 1: 在 src/api/files.ts 中导入 hash 工具和 updateFileHashes**

在文件顶部导入区域添加：

```typescript
import { computeHashes } from '../utils/hash';
import {
  getFile,
  putFile,
  deleteFile,
  listFilesInFolder,
  searchFiles,
  updateFileHashes,
} from '../db/files';
```

- [ ] **Step 2: 在 src/api/files.ts 末尾添加 info 函数**

```typescript
export async function info(request: Request, env: Env): Promise<Response> {
  const id = extractPathParam(new URL(request.url), 'files');
  if (!id) return error('File ID required', 400);

  const meta = await getFile(env, id);
  if (!meta) return error('File not found', 404);

  if (meta.sha1 && meta.sha256) {
    return json(meta);
  }

  const object = await env.VAULT_BUCKET.get(meta.key);
  if (!object) return error('File not found in storage', 404);

  try {
    const { sha1, sha256 } = await computeHashes(object.body);
    await updateFileHashes(env, id, sha1, sha256);
    meta.sha1 = sha1;
    meta.sha256 = sha256;
    return json(meta);
  } catch (e) {
    return error(
      e instanceof Error ? e.message : 'Hash computation failed',
      500,
    );
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/api/files.ts
git commit -m "feat(api): 添加 GET /api/files/:id/info 端点（延迟计算并缓存哈希）"
```

---

## Task 3: 注册 /api/files/:id/info 路由

**Files:**
- Modify: `src/router.ts`

- [ ] **Step 1: 查看当前路由注册方式**

```bash
grep -n "files" src/router.ts | head -10
```

- [ ] **Step 2: 在 src/router.ts 中注册 info 路由**

找到现有的文件相关路由（如 GET /api/files/:id），在其附近添加：

```typescript
// 注意：路由注册的具体语法需要根据 src/router.ts 中现有模式来调整
// 通常类似：
// router.get('/api/files/:id/info', withAuth(files.info));
// 或基于现有的 if/else 路径匹配
```

阅读 src/router.ts 现有结构，按照同样模式添加 info 路由。

- [ ] **Step 3: 验证编译**

```bash
npm run typecheck
```

预期：无 TypeScript 错误

- [ ] **Step 4: 提交**

```bash
git add src/router.ts
git commit -m "feat(router): 注册 /api/files/:id/info 路由"
```

---

## Task 4: 实现数据重置 API

**Files:**
- Create: `src/api/admin.ts`

- [ ] **Step 1: 创建 src/api/admin.ts**

```typescript
import type { Env } from '../utils/types';
import { json, error } from '../utils/response';

export async function resetAll(_request: Request, env: Env): Promise<Response> {
  let deletedFiles = 0;
  let cursor: string | undefined;

  try {
    do {
      const listed = await env.VAULT_BUCKET.list({ cursor, limit: 1000 });
      if (listed.objects.length > 0) {
        await env.VAULT_BUCKET.delete(listed.objects.map((o) => o.key));
        deletedFiles += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    await env.VAULT_DB.batch([
      env.VAULT_DB.prepare('DELETE FROM files'),
      env.VAULT_DB.prepare('DELETE FROM folders'),
      env.VAULT_DB.prepare('DELETE FROM shares'),
      env.VAULT_DB.prepare('DELETE FROM stats'),
    ]);

    return json({ success: true, deletedFiles });
  } catch (e) {
    return error(
      e instanceof Error ? e.message : 'Reset failed',
      500,
    );
  }
}
```

- [ ] **Step 2: 在 src/router.ts 中注册路由**

按照现有路由模式添加：`POST /api/admin/reset-all -> admin.resetAll`（需要鉴权）

- [ ] **Step 3: 验证编译**

```bash
npm run typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/api/admin.ts src/router.ts
git commit -m "feat(api): 添加 POST /api/admin/reset-all 端点（清除 R2 与 D1 数据）"
```

---

## Task 5: 前端 API 调用函数

**Files:**
- Modify: `web/src/api/index.ts`

- [ ] **Step 1: 在 web/src/api/index.ts 中添加函数**

```typescript
export async function getFileInfo(fileId: string): Promise<FileMeta> {
  const res = await fetch(`/api/files/${fileId}/info`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || '获取文件信息失败');
  }
  return res.json();
}

export async function resetAllData(): Promise<{ success: boolean; deletedFiles: number }> {
  const res = await fetch('/api/admin/reset-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || '重置失败');
  }
  return res.json();
}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/api/index.ts
git commit -m "feat(api-client): 添加 getFileInfo 与 resetAllData 函数"
```

---

## Task 6: 实现 FileInfoDialog 组件

**Files:**
- Modify: `web/src/features/dashboard/Modals.tsx`

- [ ] **Step 1: 在 Modals.tsx 中添加 FileInfoDialog 组件**

在文件末尾（ToggleRow 之前或之后）添加：

```tsx
import { formatBytes } from '~/lib/format';
import { getFileInfo } from '~/api';
import { IconCopy } from '~/ui';

export const FileInfoDialog: Component<{
  file: FileMeta | null;
  onClose: () => void;
}> = (props) => {
  const toast = useToast();
  const [info, { refetch }] = createResource(
    () => props.file?.id,
    async (id) => getFileInfo(id),
  );

  const copy = async (label: string, value: string | null) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} 已复制`);
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <Dialog open={!!props.file} onClose={props.onClose} title="文件信息" maxWidth="560px">
      <Show when={!info.loading} fallback={
        <div class="py-8 flex flex-col items-center gap-3">
          <Spinner />
          <span class="text-[12px] text-fg-muted">正在计算文件哈希值…</span>
        </div>
      }>
        <Show when={info()}>
          {(meta) => (
            <div class="space-y-3 text-[13px]">
              <InfoRow label="文件名" value={meta().name} />
              <InfoRow label="大小" value={formatBytes(meta().size)} />
              <InfoRow label="类型" value={meta().type || '—'} />
              <InfoRow label="上传时间" value={new Date(meta().uploadedAt).toLocaleString()} />
              <InfoRow label="下载次数" value={String(meta().downloads)} />
              <div class="border-t hairline pt-3 space-y-2">
                <HashRow label="SHA-1" value={meta().sha1} onCopy={(v) => copy('SHA-1', v)} />
                <HashRow label="SHA-256" value={meta().sha256} onCopy={(v) => copy('SHA-256', v)} />
              </div>
            </div>
          )}
        </Show>
      </Show>
    </Dialog>
  );
};

const InfoRow: Component<{ label: string; value: string }> = (props) => (
  <div class="flex items-baseline gap-3">
    <span class="text-fg-muted w-20 shrink-0">{props.label}</span>
    <span class="flex-1 break-words">{props.value}</span>
  </div>
);

const HashRow: Component<{ label: string; value: string | null; onCopy: (v: string | null) => void }> = (props) => (
  <div>
    <div class="flex items-center justify-between gap-2 mb-1">
      <span class="text-fg-muted text-[12px]">{props.label}</span>
      <button
        type="button"
        class="text-fg-muted hover:text-brand transition-colors"
        onClick={() => props.onCopy(props.value)}
        title="复制"
      >
        <IconCopy size={13} />
      </button>
    </div>
    <code class="block font-mono text-[11px] break-all bg-bg-inset rounded px-2 py-1.5">
      {props.value ?? '—'}
    </code>
  </div>
);
```

注意：`createResource` 已在文件顶部 import 中存在，`Show / Component / createSignal / createEffect` 已存在。如果 IconCopy 已存在则直接使用。

- [ ] **Step 2: 验证编译**

```bash
cd web && npx tsc --noEmit
```

- [ ] **Step 3: 提交**

```bash
git add web/src/features/dashboard/Modals.tsx
git commit -m "feat(dashboard): 添加 FileInfoDialog 组件展示文件详情与哈希"
```

---

## Task 7: 在 dashboard.tsx 集成"信息"菜单项

**Files:**
- Modify: `web/src/apps/dashboard.tsx`

- [ ] **Step 1: 添加状态与 import**

在 import 中加入 `FileInfoDialog`：

```tsx
import {
  ConfirmDialog,
  FileInfoDialog,
  FolderShareLinkDialog,
  MoveDialog,
  NewFolderDialog,
  RenameDialog,
  SettingsDialog,
  ShareFileDialog,
} from '~/features/dashboard/Modals';
```

在 DashboardApp 组件内添加状态：

```tsx
const [fileInfo, setFileInfo] = createSignal<FileMeta | null>(null);
```

- [ ] **Step 2: 在 fileMenuItems 中添加"信息"项**

修改 fileMenuItems 函数：

```tsx
const fileMenuItems = (f: FileMeta): MenuItem[] => [
  { label: '分享', icon: <IconShare size={14} />, onClick: () => setShareFile(f) },
  { label: '信息', icon: <IconFile size={14} />, onClick: () => setFileInfo(f) },
  { label: '下载', icon: <IconDownload size={14} />, onClick: () => downloadFile(f) },
  // ...保留原有其他菜单项
];
```

如有更合适的"信息"图标（如 IconInfo）则使用它，否则用 IconFile 临时占位。

- [ ] **Step 3: 渲染 FileInfoDialog**

在 JSX 末尾的对话框区域添加：

```tsx
<FileInfoDialog file={fileInfo()} onClose={() => setFileInfo(null)} />
```

- [ ] **Step 4: 验证编译并提交**

```bash
cd web && npx tsc --noEmit
git add web/src/apps/dashboard.tsx
git commit -m "feat(dashboard): 在文件右键菜单添加'信息'项"
```

---

## Task 8: 在 SettingsDialog 添加危险区域

**Files:**
- Modify: `web/src/features/dashboard/Modals.tsx`

- [ ] **Step 1: 在 SettingsDialog 中添加状态**

在 SettingsDialog 组件内添加：

```tsx
const [showResetConfirm, setShowResetConfirm] = createSignal(false);
const [resetting, setResetting] = createSignal(false);
```

- [ ] **Step 2: 在 SettingsDialog JSX 末尾（最后一个 ToggleRow 之后，关闭 div 之前）添加危险区域**

```tsx
<div class="mt-6 pt-6 border-t hairline">
  <div class="flex items-start gap-3 p-4 rounded-lg border border-danger/30 bg-danger/5">
    <div class="flex-1 min-w-0">
      <h3 class="text-[13px] font-semibold text-danger mb-1">危险操作</h3>
      <p class="text-[12px] text-fg-muted mb-3">
        重置后将永久删除所有文件、文件夹、分享链接和统计数据。站点设置将被保留。
      </p>
      <Button
        variant="danger"
        size="sm"
        onClick={() => setShowResetConfirm(true)}
      >
        重置所有数据
      </Button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: 在 SettingsDialog 末尾添加 ConfirmDialog**

```tsx
<ConfirmDialog
  open={showResetConfirm()}
  onClose={() => setShowResetConfirm(false)}
  title="确认重置所有数据？"
  description="此操作将永久删除所有文件、文件夹、分享链接和统计数据。站点设置将被保留。此操作不可撤销。"
  variant="danger"
  confirmLabel="我确定要重置"
  onConfirm={async () => {
    setResetting(true);
    try {
      const result = await resetAllData();
      toast.success(`已重置，删除了 ${result.deletedFiles} 个文件`);
      window.location.href = '/';
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重置失败');
    } finally {
      setResetting(false);
    }
  }}
/>
```

并在文件顶部 import：

```tsx
import { resetAllData } from '~/api';
```

注意：ConfirmDialog 在同一个 Modals.tsx 中，可以直接使用。

- [ ] **Step 4: 验证编译并提交**

```bash
cd web && npx tsc --noEmit
git add web/src/features/dashboard/Modals.tsx
git commit -m "feat(settings): 添加危险区域与重置所有数据按钮"
```

---

## Task 9: 整体构建与回归验证

- [ ] **Step 1: 运行类型检查**

```bash
npm run typecheck
```

预期：无错误。

- [ ] **Step 2: 运行构建**

```bash
npm run build
```

预期：构建成功，wrangler dry-run 通过。

- [ ] **Step 3: 检查所有提交**

```bash
git log --oneline -10
```

预期：看到本次实现的所有原子提交。

- [ ] **Step 4: 如发现问题修复后重新提交**

如有 TS 类型错误或构建错误，定位修复，按原子提交规范创建修复提交。

---

## 验证清单（手动测试，在用户实际部署后执行）

### 文件信息功能
- [ ] 上传小文件，右键 → 信息 → 显示哈希值
- [ ] 再次查看相同文件 → 立即显示（已缓存）
- [ ] 复制 SHA-1/SHA-256 → 验证内容正确
- [ ] 上传 0 字节文件 → SHA-256 应为 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
- [ ] wrangler d1 execute 验证哈希已写入

### 数据重置功能
- [ ] 准备测试数据
- [ ] 设置 → 危险区域 → 重置所有数据 → 二次确认
- [ ] 取消 → 数据保留
- [ ] 确认 → 数据清空，站点设置保留

