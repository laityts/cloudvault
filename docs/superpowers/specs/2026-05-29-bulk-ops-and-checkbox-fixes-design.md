# 设计：移动端勾选框可见性 + 批量打包/批量移动健壮性修复

**日期**：2026-05-29
**作者**：协同设计（用户 × 助手）
**状态**：草案（待用户审阅）

## 1. 背景与问题

dashboard 网格视图在移动端有三个并发问题，均与"批量操作"链路相关：

1. **文件卡片左上角勾选框在暗色主题下视觉看不见**——DOM 存在、点击位置生效，但用户在移动端无法通过视觉发现可勾选状态。
2. **批量打包下载（zip）在文件较多/较大时报 `Failed to download zip`**。
3. **批量移动文件在 ID 较多时报 `Response closed due to connection limit`**。

## 2. 根因分析

### 2.1 勾选框看不见

`web/src/features/dashboard/FileViews.tsx:155-173` 中，未选中态使用 `bg-bg-surface/85`，与卡片底色 `surface` 同色（`oklch(20.5% 0.009 250)`）；勾选框定位于 `top-1.5 left-1.5`，落在卡片 `p-2.5` 的 padding 区域而**非缩略图上**。暗色主题下未选中勾选框 ≈ 卡片底色，几乎不可分辨。桌面端通过 hover 才显示，问题相对隐蔽；移动端没有 hover、且勾选框被代码强制 `opacity-100` 常显，反而更暴露此问题。

### 2.2 zip 打包失败

`src/api/media.ts:44-156` 当前实现：

- `Promise.all(metas.map(m => env.VAULT_BUCKET.get(m.key)))` 并发拉所有 R2 对象；
- 对每个对象 `arrayBuffer()` 把整个文件读到内存；
- 用 `Uint8Array` 拼出整个 zip 后一次性 `new Response(zipBuffer)`。

两个失败点：

- **OOM**：Worker 内存上限 128MB，所有文件 buffer 全在内存里，10 个 50MB 的文件就爆。
- **connection limit**：`Promise.all` 同时打开过多 R2 GET 子请求，触发 Workers "同时打开的连接数" 限制。

### 2.3 批量移动失败

`src/api/files.ts:225-257` 的 `moveFiles` 用 `Promise.all` 并发处理所有 ID，每个 ID 触发：

1. D1 `getFile` 查询
2. R2 `get`（拿到流）
3. R2 `put`（流写入新 key）
4. R2 `delete`
5. D1 `putFile` 写回

当 `ids` 较多时，**同时存在的 R2 流连接** 远超 Workers 单请求并发上限，触发 `Response closed due to connection limit`。

## 3. 改动范围

| 改动点 | 文件 | 性质 |
|---|---|---|
| 勾选框配色与对比 | `web/src/features/dashboard/FileViews.tsx` | UI 修复 |
| zip 改流式 + data descriptor | `src/api/media.ts` | 后端重写 |
| 批量移动限并发 | `src/api/files.ts` | 后端重构 |

文件夹卡片**不动**——继续不显示勾选框，因为文件夹不参与批量操作（与"勾选框 = 可批量操作的语义"保持一致）。

## 4. 详细设计

### 4.1 勾选框可见性（方案 A1）

`web/src/features/dashboard/FileViews.tsx` 的 `FileCard` 中，未选中态样式由：

```tsx
'bg-bg-surface/85 border-line opacity-100 md:opacity-0 md:group-hover:opacity-100'
```

改为：

```tsx
'bg-bg-inset border-line-strong shadow-soft opacity-100 md:opacity-0 md:group-hover:opacity-100'
```

要点：
- `bg-bg-inset`——`--bg-inset` 在暗色主题下比 surface 暗 6.5%（14% vs 20.5%），亮色主题下比 surface 暗 3.5%（96.5% vs 100%），**两个主题都形成对比**。
- `border-line-strong`——比默认 `border-line` 更明显的边框，进一步强化边缘。
- `shadow-soft`——微妙阴影，让勾选框从卡片上"浮"起来。
- 不再使用透明度（`/85`），原代码的透明度让勾选框与背景混色，反而降低对比。
- 选中态 `bg-brand border-brand text-fg-onAccent` 不变。

> 实际 token 值（`web/src/styles/tokens.css`）已验证：暗色 surface=20.5%/inset=14%（差 6.5%）；亮色 surface=100%/inset=96.5%（差 3.5%）。inset 在两个主题中都与 surface 有显著亮度差，足以视觉区分。

桌面端 hover 显示、移动端常显（已通过 `(selectionMode() || selected()) && 'opacity-100'` + 移动端 `opacity-100` 实现）的逻辑不变。

> 不动 `top-1.5 left-1.5` 定位：移动到缩略图内会破坏当前视觉布局，且缩略图本身明暗不可控，对比反而不稳定。

### 4.2 zip 流式打包（合并方案 B1+B2）

#### 4.2.1 ZIP 格式调整

使用 **General Purpose Bit Flag bit 3**（streaming flag）+ **Data Descriptor** 实现真正的流式打包：

- **Local File Header**：`crc32`、`compressed_size`、`uncompressed_size` 三个字段全部写 0，并在 GP flag 中置位 bit 3（0x08）。
- **文件体之后**：写 16 字节 Data Descriptor（含可选签名 0x08074b50 + crc32 + compressed_size + uncompressed_size，4 字节版本——保持 32 位 size，不引入 zip64）。
- **Central Directory Entry**：依然写实际的 crc32 / size（这些值是在文件体流过程中累计计算得到的）。

这样 local header 不再需要预读文件即可发出，CRC 与 size 在流的过程中累计，结束后写 data descriptor 与 central directory。

#### 4.2.2 流式写出

返回 `new Response(stream, { headers: { 'Content-Type': 'application/zip', ... } })`，`stream` 是 `ReadableStream`。注意：**不再设置 `Content-Length`**（流式时无法预知；浏览器会接受 chunked 传输）。

伪代码：

```ts
const { readable, writable } = new TransformStream();
const writer = writable.getWriter();

(async () => {
  try {
    let offset = 0;
    const centralDir: Uint8Array[] = [];
    for (const meta of fileMetas) {
      const obj = await env.VAULT_BUCKET.get(meta.key);
      if (!obj) continue;

      const fileNameBytes = encoder.encode(meta.name);
      const localHeader = buildLocalHeader(fileNameBytes); // crc=0, size=0, GP bit 3 set
      await writer.write(localHeader);

      let crc = 0xFFFFFFFF;
      let size = 0;
      const reader = obj.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        crc = crc32Update(crc, value);
        size += value.length;
        await writer.write(value);
      }
      crc = (crc ^ 0xFFFFFFFF) >>> 0;

      const dataDescriptor = buildDataDescriptor(crc, size);
      await writer.write(dataDescriptor);

      centralDir.push(buildCentralDirEntry(meta.name, crc, size, offset));
      offset += localHeader.length + size + dataDescriptor.length;
    }

    let cdSize = 0;
    for (const cd of centralDir) {
      await writer.write(cd);
      cdSize += cd.length;
    }
    await writer.write(buildEOCD(centralDir.length, cdSize, offset));
  } finally {
    await writer.close();
  }
})();

return new Response(readable, { headers: { 'Content-Type': 'application/zip', ... } });
```

#### 4.2.3 串行 R2 GET

R2 GET 在循环里**串行**进行（一次只打开一个流），自然规避 connection limit。不引入并发——zip 流本身就是顺序写入，并发也无意义。

#### 4.2.4 CRC32 增量计算

把现有的一次性 `crc32(data: Uint8Array)` 拆成 `crc32Update(crc, chunk)` + 终结异或：

```ts
function crc32Update(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc;
}
```

性能上可后续引入查表法（256 entries），不在本次范围。

#### 4.2.5 上限保留

保持 `body.ids.length > 100` 的上限不变。Worker 单请求 CPU 时间也会限制总打包能力，超出上限的批量场景**不在本次范围**（参见"非范围"）。

#### 4.2.6 单文件快路径保留

`fileMetas.length === 1` 时直接 streamR2Object 透传——保留现有快路径。

### 4.3 批量移动限并发（方案 C1）

`src/api/files.ts:225-257` 的 `moveFiles` 改为有限并发（4）的工作池：

```ts
const CONCURRENCY = 4;
let cursor = 0;
let moved = 0;

async function worker() {
  while (cursor < body.ids.length) {
    const id = body.ids[cursor++]!;
    const ok = await moveOne(env, id, targetFolder);
    if (ok) moved++;
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, body.ids.length) }, worker),
);

return json({ moved });
```

`moveOne` 提取为局部函数，封装现有的 GET → PUT → DELETE → putFile 逻辑。

> 选 4 而非 1：Workers 子请求并发上限通常远高于 4，限到 4 既留出富余度避免触发上限，又能利用 R2 的 I/O 并行性。如未来仍报错可下调到 2。

> 错误处理保持现状：单个文件失败（`getFile` 返回 null、R2 get 返回 null）时跳过，不抛错；最后 `moved` 计数返回。这与原 `Promise.all` + filter Boolean 行为等价。

## 5. 非范围

显式声明**不做**的事：

- 不引入文件夹批量操作（删除/移动/zip 不扩展到文件夹）。
- 不动 zip 100 文件上限。超过该上限的场景（大批量、大体积）需要后台任务/Durable Object 方案，本次不涉及。
- 不引入 zip64（保持 32 位 size，单文件 < 4GB）。
- 不引入 deflate 压缩（保持 stored 模式，与现状一致）。
- 不动文件夹卡片视觉（不加勾选框）。
- 不动文件卡片勾选框定位（仅改配色）。
- 不动 `deleteFiles` 接口（同样有 connection limit 风险，但本次未报告，留待后续按需修复）。

## 6. 测试与验证

由于 CLAUDE.md §13 禁用真机验证，本次依赖以下非真机方式：

- **类型检查**：`npm run typecheck` 须通过。
- **构建**：`npm run build` 须通过（含 `wrangler deploy --dry-run`）。
- **逻辑推理**：
  - 勾选框：阅读 `bg-bg-base` 与 `bg-bg-surface` 的 token 值差，确认对比足够。
  - zip：手工对照 PKWARE APPNOTE.TXT §4.3.7（local header）/ §4.3.9（data descriptor）/ §4.4.4（GP flag bit 3 语义），确认字节布局。
  - move：阅读 Workers `Promise.all` 行为，确认 4 并发不会触发 connection limit。
- **单元测试**：本仓库目前无测试框架。引入测试不在本次范围（CLAUDE.md §3 简洁优先）；如后续要加，应单独规划。

## 7. 提交计划

按 CLAUDE.md §12 原子提交，拆为三个独立提交：

1. `fix(web): 网格卡片勾选框在暗色主题下可见` —— `FileViews.tsx`
2. `fix(api/media): zip 流式打包，规避 OOM 与并发上限` —— `media.ts`
3. `fix(api/files): 批量移动限并发，规避 connection limit` —— `files.ts`

每个提交独立可回滚。

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| zip data descriptor 的字节序/字段错误，导致客户端解压失败 | 严格按 APPNOTE 4.3.9 实现；与已有 central dir 写法对齐字节序（小端） |
| 限并发后批量移动整体变慢 | 4 并发对绝大多数批量场景仍然足够快；如不可接受可下调 = 1 验证后再回升 |
| `bg-bg-base/90` 在亮色主题下对比下降 | 亮色主题 `bg-base` 与 `bg-surface` 也有差，且加 `border-line-strong` + `shadow-soft` 提供双重区分 |
