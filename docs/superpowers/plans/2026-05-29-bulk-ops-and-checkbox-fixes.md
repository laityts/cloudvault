# 移动端勾选框可见性 + 批量打包/移动健壮性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复三个 dashboard 缺陷——文件卡片勾选框在暗色主题下视觉不可见、批量打包 zip 因 OOM 与 connection limit 失败、批量移动文件因 connection limit 失败。

**Architecture:** 三个独立的局部修复，按原子提交拆分。前端只改一处 className；后端 zip 改为流式 `ReadableStream` + GP flag bit 3 / Data Descriptor + 串行 R2 GET；批量移动改为 4 并发工作池替代 `Promise.all`。

**Tech Stack:** SolidJS + TailwindCSS（前端），Cloudflare Workers + R2 + D1（后端），TypeScript。

**Spec：** `docs/superpowers/specs/2026-05-29-bulk-ops-and-checkbox-fixes-design.md`

---

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `web/src/features/dashboard/FileViews.tsx` | 网格/列表视图组件，含 `FileCard` 勾选框 | 修改第 161-167 行 className |
| `src/api/media.ts` | zip 打包接口实现 | 重写 `zipDownload` 函数；新增 crc32 增量更新函数 |
| `src/api/files.ts` | 文件相关 API，含 `moveFiles` | 重构 `moveFiles`，提取 `moveOne` 局部函数 |

无新文件。三个改动各自独立、互不依赖，可按顺序提交。

---

## Task 1：勾选框在暗色主题下可见

**Files:**
- Modify: `web/src/features/dashboard/FileViews.tsx:161-167`

**目标：** 把未选中态的 `bg-bg-surface/85 border-line` 改为 `bg-bg-inset border-line-strong shadow-soft`，让勾选框在暗色（surface 20.5% vs inset 14%）和亮色（surface 100% vs inset 96.5%）主题下都能看见。

- [ ] **Step 1：定位并阅读现有代码**

读 `web/src/features/dashboard/FileViews.tsx` 第 153-173 行，确认 `FileCard` 内 selection checkmark `<button>` 的当前 className：

```tsx
class={cn(
  'absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-md border flex items-center justify-center transition',
  selected()
    ? 'bg-brand border-brand text-fg-onAccent'
    : 'bg-bg-surface/85 border-line opacity-100 md:opacity-0 md:group-hover:opacity-100',
  (selectionMode() || selected()) && 'opacity-100',
)}
```

确认只有未选中分支需要改，选中分支与外层 className 不动。

- [ ] **Step 2：修改未选中态 className**

把第 165 行：

```tsx
            : 'bg-bg-surface/85 border-line opacity-100 md:opacity-0 md:group-hover:opacity-100',
```

改成：

```tsx
            : 'bg-bg-inset border-line-strong shadow-soft opacity-100 md:opacity-0 md:group-hover:opacity-100',
```

变更点：
- `bg-bg-surface/85` → `bg-bg-inset`（去透明度，换更深/浅一档的对比色）
- `border-line` → `border-line-strong`（更明显的边框）
- 新增 `shadow-soft`（让按钮从卡片浮起）

其它 token、定位、动画、`(selectionMode() || selected()) && 'opacity-100'` 一律不改。

- [ ] **Step 3：类型检查**

Run: `npm run typecheck`
Expected: 无错误（仅改 className 字符串，类型层不会受影响）。

- [ ] **Step 4：构建**

Run: `npm run build`
Expected: `vite build` 成功 + `wrangler deploy --dry-run` 成功。

- [ ] **Step 5：阅读关联 token 验证对比**

打开 `web/src/styles/tokens.css`，确认：
- 暗色：`--bg-surface: oklch(20.5% ...)` 与 `--bg-inset: oklch(14% ...)`，差 6.5%。
- 亮色：`--bg-surface: oklch(100% ...)` 与 `--bg-inset: oklch(96.5% ...)`，差 3.5%。

如果 tokens 与上述值不一致，停下来汇报；不要继续。

- [ ] **Step 6：提交**

```bash
git add web/src/features/dashboard/FileViews.tsx
git commit -m "fix(web): 网格卡片勾选框在暗色卡片上可见"
```

---

## Task 2：zip 打包改为流式 + Data Descriptor

**Files:**
- Modify: `src/api/media.ts`（重写 `zipDownload` 函数体；保留单文件快路径与 100 文件上限；替换 `crc32` 为增量版）

**目标：** 用 `TransformStream` 边读 R2 边写出 zip，不再把所有文件加载到内存，并且 R2 GET 在循环里串行进行（每次只持有一个连接）。zip 格式用 GP flag bit 3 + Data Descriptor，让 local header 可在文件流出之前发出。

### 背景：ZIP 字段布局速查（小端）

**Local File Header（30 + nameLen 字节）：**

| offset | 大小 | 字段 | 流式取值 |
|---|---|---|---|
| 0 | 4 | 签名 0x04034b50 | 固定 |
| 4 | 2 | version needed | 20 |
| 6 | 2 | GP bit flag | **0x0008**（bit 3 = streaming） |
| 8 | 2 | compression | 0（stored） |
| 10 | 2 | mod time | 0 |
| 12 | 2 | mod date | 0 |
| 14 | 4 | crc32 | **0**（在 data descriptor 中给出） |
| 18 | 4 | compressed size | **0** |
| 22 | 4 | uncompressed size | **0** |
| 26 | 2 | filename length | nameLen |
| 28 | 2 | extra length | 0 |
| 30 | nameLen | filename | UTF-8 字节 |

**Data Descriptor（紧跟在文件体之后，16 字节）：**

| offset | 大小 | 字段 | 值 |
|---|---|---|---|
| 0 | 4 | 签名 0x08074b50 | 固定 |
| 4 | 4 | crc32 | 实际 crc |
| 8 | 4 | compressed size | 实际大小 |
| 12 | 4 | uncompressed size | 实际大小（与 compressed 相同，因为 stored） |

**Central Directory Entry（46 + nameLen 字节）：** 与现有代码一致，唯一区别是 GP flag 字段（offset 8）也要置 0x0008，让解压器知道该条目对应 streaming 模式；crc/size 字段要写入实际累计值。

**EOCD（22 字节）：** 与现有代码一致。

### 任务步骤

- [ ] **Step 1：阅读现有 `src/api/media.ts`**

读完整个文件（167 行），重点看：
- `zipDownload` 第 44-156 行：当前所有 OOM/连接上限的来源。
- `crc32` 第 158-167 行：一次性计算，要换成增量。
- `streamR2Object` 与 `getFile` 的导入。

- [ ] **Step 2：写"失败重现"的逻辑断言（无测试框架，用代码注释 + 阅读对比）**

仓库目前没有测试框架（`package.json` 无 `test` 脚本）。引入测试不在本次范围。改为在 PR/提交说明里描述：

> 重现：旧实现并发 `Promise.all(metas.map(get))` 拉取所有 R2 对象后 `arrayBuffer()` 入内存，超过 ~100MB 总大小即 OOM；同时打开过多 R2 流也会触发 connection limit。新实现用 `TransformStream` 流式输出，串行 R2 GET。

不写测试代码，但**必须**在动手改之前把上述判断写进 commit message 草稿，作为后续 review 时的对照依据。把这句话先存进 `/tmp/zip-fix-commit.md`：

```bash
cat > /tmp/zip-fix-commit.md <<'EOF'
fix(api/media): zip 流式打包，规避 OOM 与连接上限

- 改用 TransformStream 边读 R2 边输出 zip，内存峰值降为单 chunk 级（KB）。
- 用 GP flag bit 3 + Data Descriptor，local header 可先于文件体发出。
- R2 GET 在循环中串行，规避 Workers 单请求并发连接上限。
- 保留 100 文件上限与单文件快路径。
EOF
```

- [ ] **Step 3：替换 crc32 为增量版**

把 `src/api/media.ts` 第 158-167 行整个 `crc32` 函数：

```ts
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

替换为增量版：

```ts
const CRC32_INIT = 0xFFFFFFFF;

function crc32Update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc;
}

function crc32Final(crc: number): number {
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

- [ ] **Step 4：在 `crc32Final` 之上新增三个 zip 字节构造辅助函数**

在 `src/api/media.ts` 文件末尾（紧跟在新 `crc32Final` 之后）追加：

```ts
function buildLocalHeader(fileName: Uint8Array): Uint8Array {
  const buf = new Uint8Array(30 + fileName.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 0x0008, true); // GP flag: bit 3 = data descriptor follows
  v.setUint16(8, 0, true);      // stored
  v.setUint16(10, 0, true);     // mod time
  v.setUint16(12, 0, true);     // mod date
  v.setUint32(14, 0, true);     // crc32 = 0 (in data descriptor)
  v.setUint32(18, 0, true);     // compressed size = 0
  v.setUint32(22, 0, true);     // uncompressed size = 0
  v.setUint16(26, fileName.length, true);
  v.setUint16(28, 0, true);     // extra length
  buf.set(fileName, 30);
  return buf;
}

function buildDataDescriptor(crc: number, size: number): Uint8Array {
  const buf = new Uint8Array(16);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x08074b50, true);
  v.setUint32(4, crc, true);
  v.setUint32(8, size, true);   // compressed size (stored = uncompressed)
  v.setUint32(12, size, true);  // uncompressed size
  return buf;
}

function buildCentralDirEntry(
  fileName: Uint8Array,
  crc: number,
  size: number,
  localHeaderOffset: number,
): Uint8Array {
  const buf = new Uint8Array(46 + fileName.length);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true);     // version made by
  v.setUint16(6, 20, true);     // version needed
  v.setUint16(8, 0x0008, true); // GP flag: bit 3
  v.setUint16(10, 0, true);     // stored
  v.setUint16(12, 0, true);     // mod time
  v.setUint16(14, 0, true);     // mod date
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);  // compressed size
  v.setUint32(24, size, true);  // uncompressed size
  v.setUint16(28, fileName.length, true);
  v.setUint16(30, 0, true);     // extra length
  v.setUint16(32, 0, true);     // comment length
  v.setUint16(34, 0, true);     // disk number
  v.setUint16(36, 0, true);     // internal attrs
  v.setUint32(38, 0, true);     // external attrs
  v.setUint32(42, localHeaderOffset, true);
  buf.set(fileName, 46);
  return buf;
}

function buildEOCD(entryCount: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(4, 0, true);              // disk number
  v.setUint16(6, 0, true);              // disk with cd
  v.setUint16(8, entryCount, true);     // entries on this disk
  v.setUint16(10, entryCount, true);    // total entries
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, 0, true);             // comment length
  return buf;
}
```

- [ ] **Step 5：重写 `zipDownload`**

把 `src/api/media.ts` 第 44-156 行（整个 `zipDownload` 函数体）替换为：

```ts
export async function zipDownload(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ ids: string[] }>(request);
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.ids.length > 100) return error('Max 100 files per zip', 400);

  const fetchedMetas = await Promise.all(body.ids.map((id) => getFile(env, id)));
  const fileMetas: FileMeta[] = fetchedMetas.filter((m): m is FileMeta => m !== null);
  if (fileMetas.length === 0) return error('No valid files found', 404);

  if (fileMetas.length === 1) {
    const meta = fileMetas[0]!;
    const object = await env.VAULT_BUCKET.get(meta.key);
    if (!object) return error('File not found in storage', 404);
    return streamR2Object(object, request, {
      headers: {
        'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.name)}"`,
      },
    });
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Stream zip body asynchronously; do not await before returning Response.
  (async () => {
    try {
      let offset = 0;
      const centralDir: Uint8Array[] = [];

      for (const meta of fileMetas) {
        const obj = await env.VAULT_BUCKET.get(meta.key);
        if (!obj) continue;

        const fileName = encoder.encode(meta.name);
        const localHeader = buildLocalHeader(fileName);
        await writer.write(localHeader);

        let crc = CRC32_INIT;
        let size = 0;
        const reader = obj.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32Update(crc, value);
          size += value.length;
          await writer.write(value);
        }
        const finalCrc = crc32Final(crc);

        const descriptor = buildDataDescriptor(finalCrc, size);
        await writer.write(descriptor);

        centralDir.push(buildCentralDirEntry(fileName, finalCrc, size, offset));
        offset += localHeader.length + size + descriptor.length;
      }

      let cdSize = 0;
      for (const cd of centralDir) {
        await writer.write(cd);
        cdSize += cd.length;
      }
      await writer.write(buildEOCD(centralDir.length, cdSize, offset));
    } catch (err) {
      try { await writer.abort(err); } catch { /* ignore */ }
      return;
    }
    await writer.close();
  })();

  const zipName = 'cloudvault-' + new Date().toISOString().slice(0, 10) + '.zip';
  return new Response(readable, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="' + zipName + '"',
    },
  });
}
```

注意：
- **不再设置 `Content-Length`**——流式响应，浏览器走 chunked。
- 单文件快路径用 `streamR2Object`，与流前完全分离，保留原行为。
- 失败时调 `writer.abort(err)`，让客户端感知到流中止；不再吞错。
- `obj.body.getReader()` 一次只持有一个 R2 流（串行），规避 connection limit。

- [ ] **Step 6：删除旧的"非流式"中间数据结构（如 IDE 因人工误改残留）**

`zipDownload` 替换完成后，确认没有残留：
- 旧的 `parts: Uint8Array[]`、`zipBuffer = new Uint8Array(totalSize)`、循环拷贝段，都应不存在。
- 旧的 `crc32` 一次性函数应被 `crc32Update`/`crc32Final` 替代。

Run: `grep -n "zipBuffer\|new Uint8Array(totalSize)" src/api/media.ts`
Expected: 无输出。

Run: `grep -n "function crc32\b" src/api/media.ts`
Expected: 无输出（只剩 `crc32Update` 与 `crc32Final`）。

- [ ] **Step 7：补一处类型导入**

文件顶部已有：

```ts
import type { Env, FileMeta } from '../utils/types';
```

不需要新增 import；旧代码已经导入了 `FileMeta`。如果 `grep -n "import type" src/api/media.ts | head -1` 显示已包含 `FileMeta`，跳过；否则加上。

- [ ] **Step 8：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

如果出错，常见问题：
- `obj.body` 是 `ReadableStream<Uint8Array> | null`——已用 `if (!obj) continue` 排除 null。
- `value` 来自 `reader.read()` 的 `Uint8Array`——`crc32Update(number, Uint8Array)` 签名匹配。

- [ ] **Step 9：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 10：提交**

```bash
git add src/api/media.ts
git commit -F /tmp/zip-fix-commit.md
rm /tmp/zip-fix-commit.md
```

---

## Task 3：批量移动改为限并发工作池

**Files:**
- Modify: `src/api/files.ts:225-257`（重构 `moveFiles`，提取 `moveOne`）

**目标：** 用 4 并发的工作池替代 `Promise.all`，避免一次打开过多 R2 流。

- [ ] **Step 1：阅读现有 `moveFiles`**

读 `src/api/files.ts:225-257`。确认：
- 入参：`{ ids: string[]; targetFolder: string }`
- 单个 ID 处理：`getFile` → `R2.get` → `R2.put`（流复制）→ `R2.delete` → `putFile`
- 错误处理：`getFile` 返回 null 或 `R2.get` 返回 null 时跳过（不抛）
- 返回：`{ moved: <成功数> }`

- [ ] **Step 2：用工作池实现替换函数体**

把 `src/api/files.ts:225-257`（`export async function moveFiles ... }` 完整函数）替换为：

```ts
export async function moveFiles(request: Request, env: Env): Promise<Response> {
  const body = await parseJson<{ ids: string[]; targetFolder: string }>(request);
  if (!body.ids?.length) return error('No file IDs provided', 400);
  if (body.targetFolder === undefined) return error('Target folder required', 400);

  const targetFolder = body.targetFolder;
  const ids = body.ids;

  const moveOne = async (id: string): Promise<boolean> => {
    const meta = await getFile(env, id);
    if (!meta) return false;
    if (meta.folder === targetFolder) return false;

    const newKey = buildR2Key(targetFolder, meta.name);

    const oldObject = await env.VAULT_BUCKET.get(meta.key);
    if (!oldObject) return false;

    await env.VAULT_BUCKET.put(newKey, oldObject.body, {
      httpMetadata: oldObject.httpMetadata,
      customMetadata: oldObject.customMetadata,
    });
    await env.VAULT_BUCKET.delete(meta.key);

    meta.key = newKey;
    meta.folder = targetFolder;
    await putFile(env, meta);
    return true;
  };

  const CONCURRENCY = 4;
  let cursor = 0;
  let moved = 0;

  const worker = async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      const ok = await moveOne(ids[i]!);
      if (ok) moved++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()),
  );

  return json({ moved });
}
```

要点：
- `cursor` 在 worker 间共享，`cursor++` 是 V8 单线程下的原子读改写，无竞态。
- `moved` 同理（worker 是 promise 而非真正并行线程，++ 安全）。
- `CONCURRENCY = 4` 与 spec §4.3 对齐。
- `moveOne` 行为与原来逐 ID 处理完全等价，便于对照 review。

- [ ] **Step 3：类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 4：构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 5：阅读对照**

`grep -n "Promise.all" src/api/files.ts`
Expected: 输出 1 行（在新 `moveFiles` 末尾的 `await Promise.all(Array.from(...))`），不再有 `body.ids.map(async (id) => ...)`。

`grep -n "body.ids.map" src/api/files.ts`
Expected: 无输出。

- [ ] **Step 6：提交**

```bash
git add src/api/files.ts
git commit -m "fix(api/files): 批量移动限并发，规避 connection limit"
```

---

## Task 4：本地端到端 sanity check

**目标：** 三个修复都已落地，最后做一次整仓 lint + build 验证，并阅读 `dist/`/`public/` 是否包含旧产物（无需手动构建产物）。

- [ ] **Step 1：完整类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 2：完整构建**

Run: `npm run build`
Expected: `vite build` 成功，`wrangler deploy --dry-run` 成功。

- [ ] **Step 3：git status 应当干净**

Run: `git status`
Expected: 工作区干净（前一个 task 提交后），或仅含 `public/assets/` 等构建产物（被 `prebuild:web` 清理重建）。

如果出现意外的未跟踪文件，停下来人工检查；不要 `git clean`。

- [ ] **Step 4：检视提交序列**

Run: `git log --oneline -5`
Expected：从最新到最旧依次出现：
1. `fix(api/files): 批量移动限并发，规避 connection limit`（Task 3）
2. `fix(api/media): zip 流式打包，规避 OOM 与连接上限`（Task 2）
3. `fix(web): 网格卡片勾选框在暗色卡片上可见`（Task 1）
4. `docs(specs): 移动端勾选框可见性与批量打包/移动健壮性设计`（写计划前已提交，commit 72a6ef3）
5. （此前的最新提交）

如果前 3 个 fix 顺序不一致或缺失，不要 rebase 自动修复，先汇报。

---

## Self-Review

**1. Spec coverage：**

| Spec 节 | 对应 Task |
|---|---|
| §4.1 勾选框可见性 | Task 1 |
| §4.2.1 ZIP 格式调整（GP bit 3 + data descriptor） | Task 2 Step 4 |
| §4.2.2 流式写出（TransformStream） | Task 2 Step 5 |
| §4.2.3 串行 R2 GET | Task 2 Step 5（`for (const meta of fileMetas)` 串行） |
| §4.2.4 CRC32 增量计算 | Task 2 Step 3 |
| §4.2.5 上限保留（100 文件） | Task 2 Step 5（`if (body.ids.length > 100)`） |
| §4.2.6 单文件快路径 | Task 2 Step 5（`if (fileMetas.length === 1)`） |
| §4.3 限并发 4 移动 | Task 3 |
| §6 测试与验证（typecheck + build） | Task 1 Step 3-4，Task 2 Step 8-9，Task 3 Step 3-4，Task 4 |
| §7 三个原子提交 | Task 1 Step 6，Task 2 Step 10，Task 3 Step 6 |

无遗漏。

**2. Placeholder 扫描：** 无 TBD / TODO / "类似 Task N" / "适当的错误处理"等占位。每一处代码都给出了完整可粘贴的实现。

**3. Type 一致性：**
- `crc32Update(crc: number, data: Uint8Array): number` 在 Task 2 Step 3 定义，Step 5 调用 `crc = crc32Update(crc, value)`、`crc32Final(crc)` 一致。
- `buildLocalHeader(fileName: Uint8Array)`、`buildDataDescriptor(crc, size)`、`buildCentralDirEntry(fileName, crc, size, offset)`、`buildEOCD(entryCount, cdSize, cdOffset)` 在 Step 4 定义，Step 5 调用全部参数顺序、类型一致。
- `moveOne(id: string): Promise<boolean>` 在 Task 3 Step 2 定义并调用。
- `FileMeta` 来自 `src/utils/types`，`media.ts` 顶部已经 import，无需新增。

无类型不一致。
