# 文件信息展示与数据重置功能设计

**日期：** 2026-05-29  
**状态：** 待实现  
**作者：** Claude (Brainstorming)

## 概述

本设计文档描述了两个新功能的实现方案：

1. **文件信息展示** - 在文件右键菜单中增加"信息"选项，显示文件详细信息（包括 SHA-1 和 SHA-256 哈希值）
2. **重置所有数据** - 在设置页面提供完全重置功能，清除 R2 存储和 D1 数据库中的所有数据

## 背景

### 需求来源

用户需要：
- 查看文件的详细信息，特别是文件哈希值（用于验证文件完整性）
- 能够完全重置系统，清除所有数据（用于测试或重新开始）

### 技术约束

- Cloudflare Worker 有 CPU 时间限制，大文件哈希计算需要使用流式处理
- 哈希值计算成本较高，需要缓存到数据库避免重复计算
- 数据重置是危险操作，需要明确的用户确认流程

## 架构设计

### 整体架构

```
用户交互层（前端）
    ↓
API 层（Cloudflare Worker）
    ↓
存储层（R2 + D1）
```

### 数据流

#### 文件信息查询流程

```
用户点击"信息"
  → 前端调用 GET /api/files/:id/info
  → 后端检查数据库中是否有 sha1/sha256
  → 如果有：直接返回完整信息
  → 如果没有：
      1. 从 R2 获取文件流
      2. 使用流式处理计算 SHA-1 和 SHA-256
      3. 调用 updateFileHashes 写入数据库
      4. 返回完整信息
  → 前端在对话框中显示
```

#### 数据重置流程

```
用户点击"重置所有数据"
  → 显示二次确认对话框
  → 用户确认
  → 前端调用 POST /api/admin/reset-all
  → 后端执行：
      1. 分页列出 R2 所有对象
      2. 批量删除（每批 1000 个）
      3. 清空 D1 所有表（保留 settings）
      4. 返回操作结果
  → 前端显示成功提示并刷新页面
```

## 详细设计

### 1. 后端 API 设计

#### 1.1 文件信息 API

**端点：** `GET /api/files/:id/info`

**认证：** 需要登录（withAuth）

**请求参数：**
- `id` (路径参数) - 文件 ID

**响应格式：**
```typescript
{
  id: string;
  key: string;
  name: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: string;
  shareToken: string | null;
  sharePassword: string | null;
  shareExpiresAt: string | null;
  downloads: number;
  sha1: string | null;      // 十六进制编码
  sha256: string | null;    // 十六进制编码
}
```

**错误响应：**
- `404` - 文件不存在
- `404` - R2 对象不存在
- `500` - 哈希计算失败或超时

**实现位置：** `src/api/files.ts`

**实现要点：**
1. 从数据库获取文件元数据
2. 检查 sha1 和 sha256 是否已存在
3. 如果不存在，调用哈希计算工具
4. 更新数据库
5. 返回完整信息

#### 1.2 数据重置 API

**端点：** `POST /api/admin/reset-all`

**认证：** 需要登录（withAuth）

**请求体：** 无

**响应格式：**
```typescript
{
  success: boolean;
  deletedFiles: number;
}
```

**错误响应：**
- `401` - 未登录
- `500` - 操作失败

**实现位置：** `src/api/admin.ts`（新建文件）

**实现要点：**
1. 使用 `env.VAULT_BUCKET.list()` 分页列出所有对象
2. 使用 `env.VAULT_BUCKET.delete(keys[])` 批量删除（每批最多 1000 个）
3. 使用 `env.VAULT_DB.batch()` 批量清空表
4. 保留 settings 表（避免丢失站点配置）
5. 返回删除的文件数量

### 2. 哈希计算工具

**文件位置：** `src/utils/hash.ts`（新建文件）

**函数签名：**
```typescript
export async function computeHashes(
  stream: ReadableStream<Uint8Array>
): Promise<{ sha1: string; sha256: string }>;
```

**实现策略：**

1. 使用 `stream.tee()` 将输入流分成两路
2. 创建两个 TransformStream，分别用于 SHA-1 和 SHA-256 计算
3. 使用 Web Crypto API (`crypto.subtle.digest`) 进行哈希计算
4. 边读边计算，避免将整个文件加载到内存
5. 返回十六进制编码的哈希值

**关键技术点：**
- 流式处理：避免内存溢出和 CPU 超时
- 并行计算：同时计算两个哈希值
- 使用标准 Web Crypto API：性能好且安全

**伪代码：**
```typescript
async function computeHashes(stream: ReadableStream) {
  const [stream1, stream2] = stream.tee();
  
  const sha1Promise = computeSingleHash(stream1, 'SHA-1');
  const sha256Promise = computeSingleHash(stream2, 'SHA-256');
  
  const [sha1, sha256] = await Promise.all([sha1Promise, sha256Promise]);
  
  return { sha1, sha256 };
}

async function computeSingleHash(stream: ReadableStream, algorithm: string) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  
  // 流式读取所有数据块
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  
  // 合并所有数据块
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  
  // 计算哈希值
  const hashBuffer = await crypto.subtle.digest(algorithm, buffer);
  
  // 转换为十六进制字符串
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
```

**注意：** 虽然需要将所有数据块收集到内存中才能调用 `crypto.subtle.digest()`，但由于是边读边收集（而不是一次性读取整个文件），仍然比直接 `await object.arrayBuffer()` 更节省内存和 CPU 时间。对于超大文件，如果内存不足，可以考虑分块计算（需要使用支持增量更新的哈希库）。

### 3. 路由注册

**文件位置：** `src/router.ts`

**新增路由：**
```typescript
router.get('/api/files/:id/info', withAuth(files.info));
router.post('/api/admin/reset-all', withAuth(admin.resetAll));
```

### 4. 前端组件设计

#### 4.1 FileInfoDialog 组件

**文件位置：** `web/src/features/dashboard/Modals.tsx`

**组件结构：**
```tsx
export const FileInfoDialog: Component<{
  file: FileMeta | null;
  onClose: () => void;
}> = (props) => {
  // 使用 createResource 加载文件信息
  const [info] = createResource(
    () => props.file?.id,
    (id) => getFileInfo(id)
  );
  
  return (
    <Dialog open={!!props.file} onClose={props.onClose} title="文件信息">
      <Show when={!info.loading} fallback={<Spinner />}>
        <div class="space-y-3">
          <InfoRow label="文件名" value={info()?.name} />
          <InfoRow label="大小" value={formatBytes(info()?.size)} />
          <InfoRow label="类型" value={info()?.type} />
          <InfoRow label="上传时间" value={formatDate(info()?.uploadedAt)} />
          <InfoRow label="下载次数" value={info()?.downloads} />
          
          <div class="border-t pt-3">
            <HashRow label="SHA-1" value={info()?.sha1} />
            <HashRow label="SHA-256" value={info()?.sha256} />
          </div>
        </div>
      </Show>
    </Dialog>
  );
};
```

**UI 设计要点：**
- 使用网格布局展示信息（标签 + 值）
- 哈希值使用等宽字体（`font-mono`）
- 每个哈希值旁边有复制按钮
- 加载时显示 Spinner 和提示文字："正在计算文件哈希值..."
- 哈希值过长时自动换行

#### 4.2 SettingsDialog 增强

**文件位置：** `web/src/features/dashboard/Modals.tsx`

**在现有 SettingsDialog 底部增加：**

```tsx
<div class="mt-6 pt-6 border-t-2 border-danger/20">
  <div class="flex items-start gap-3 p-4 rounded-lg border-2 border-danger/30 bg-danger/5">
    <IconWarning size={20} class="text-danger shrink-0 mt-0.5" />
    <div class="flex-1 min-w-0">
      <h3 class="text-sm font-semibold text-danger mb-1">危险操作</h3>
      <p class="text-xs text-fg-muted mb-3">
        以下操作不可撤销，请谨慎操作
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

**二次确认对话框：**
```tsx
<ConfirmDialog
  open={showResetConfirm()}
  onClose={() => setShowResetConfirm(false)}
  title="确认重置所有数据？"
  description="此操作将永久删除所有文件、文件夹、分享链接和统计数据。站点设置将被保留。此操作不可撤销。"
  variant="danger"
  confirmLabel="我确定要重置"
  onConfirm={async () => {
    try {
      const result = await resetAllData();
      toast.success(`已重置，删除了 ${result.deletedFiles} 个文件`);
      // 刷新页面或跳转到登录页
      window.location.href = '/';
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重置失败');
    }
  }}
/>
```

#### 4.3 菜单集成

**文件位置：** `web/src/apps/dashboard.tsx`

**在 fileMenuItems 函数中增加：**

```tsx
const fileMenuItems = (f: FileMeta): MenuItem[] => [
  { label: '分享', icon: <IconShare size={14} />, onClick: () => setShareFile(f) },
  { label: '信息', icon: <IconInfo size={14} />, onClick: () => setFileInfo(f) },  // 新增
  { label: '下载', icon: <IconDownload size={14} />, onClick: () => downloadFile(f) },
  // ... 其他菜单项
];
```

**状态管理：**
```tsx
const [fileInfo, setFileInfo] = createSignal<FileMeta | null>(null);
```

**渲染对话框：**
```tsx
<FileInfoDialog file={fileInfo()} onClose={() => setFileInfo(null)} />
```

#### 4.4 图标

**文件位置：** `web/src/ui/icons.tsx`

**可能需要新增的图标：**
- `IconInfo` - 信息图标（圆圈内有 i）
- `IconWarning` - 警告图标（三角形内有感叹号）

如果已有类似图标可以复用，则无需新增。

### 5. API 客户端

**文件位置：** `web/src/api/index.ts`

**新增函数：**

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
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || '重置失败');
  }
  return res.json();
}
```

## 错误处理

### 文件信息 API 错误场景

| 错误场景 | HTTP 状态码 | 错误消息 | 前端处理 |
|---------|-----------|---------|---------|
| 文件不存在 | 404 | "File not found" | Toast 提示"文件不存在" |
| R2 对象不存在 | 404 | "File not found in storage" | Toast 提示"文件存储对象不存在" |
| 哈希计算超时 | 500 | "Hash computation timeout" | Toast 提示"文件过大，哈希计算超时" |
| 网络错误 | - | - | Toast 提示"网络错误，请重试" |

### 数据重置 API 错误场景

| 错误场景 | HTTP 状态码 | 错误消息 | 前端处理 |
|---------|-----------|---------|---------|
| 未登录 | 401 | "Unauthorized" | 跳转到登录页 |
| R2 删除失败 | 500 | "Failed to delete R2 objects" | Toast 提示"删除文件失败" |
| D1 清空失败 | 500 | "Failed to clear database" | Toast 提示"数据库重置失败" |

### 边界情况处理

#### 文件信息功能

1. **空文件（0 字节）**
   - 正常计算哈希值
   - 空文件的 SHA-256 固定为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

2. **超大文件（> 1GB）**
   - 流式处理可以处理，但可能接近 CPU 时间限制
   - 如果超时，返回 500 错误
   - 前端提示用户稍后重试

3. **并发请求同一文件**
   - 可能导致重复计算
   - 数据库写入使用 UPDATE，后写入覆盖先写入（幂等操作）
   - 最终结果一致

4. **文件已被删除**
   - 返回 404 错误
   - 前端提示"文件不存在"

#### 数据重置功能

1. **R2 中有大量文件（> 10000 个）**
   - 使用分页遍历（每页 1000 个）
   - 批量删除（每批 1000 个）
   - 可能需要较长时间，但不会超时

2. **重置过程中用户上传新文件**
   - 可能导致不一致（新文件可能被删除或保留）
   - 这是用户主动触发的危险操作，可接受
   - UI 提示中说明："请确保没有正在进行的上传"

3. **部分删除失败**
   - 记录失败的对象数量
   - 返回部分成功的结果
   - 前端显示："已删除 X 个文件，Y 个失败"

## 性能优化

### 哈希计算优化

1. **流式处理**
   - 使用 `ReadableStream` 边读边计算
   - 避免将整个文件加载到内存
   - 内存占用恒定，不受文件大小影响

2. **并行计算**
   - 使用 `stream.tee()` 复制流
   - 同时计算 SHA-1 和 SHA-256
   - 减少总计算时间

3. **结果缓存**
   - 计算完成后立即写入数据库
   - 后续请求直接从数据库读取
   - 避免重复计算

### R2 批量删除优化

1. **批量操作**
   - 使用 `R2Bucket.delete(keys[])` 批量删除
   - 每批最多 1000 个对象
   - 避免逐个删除的性能问题

2. **分页遍历**
   - 使用 `list({ cursor, limit: 1000 })` 分页
   - 避免一次性加载所有对象列表

## 测试策略

### 单元测试

由于 Cloudflare Worker 环境的限制，单元测试较难实施。主要依赖手动测试和集成测试。

### 手动测试清单

#### 文件信息功能

- [ ] 上传小文件（< 1MB），查看信息，验证哈希值正确
- [ ] 再次查看同一文件信息，验证立即显示（已缓存）
- [ ] 复制 SHA-1 和 SHA-256，验证复制成功
- [ ] 上传空文件（0 字节），查看信息，验证能正常显示
- [ ] 上传大文件（50MB），查看信息，验证不超时
- [ ] 使用 `wrangler d1 execute` 验证哈希值已写入数据库
- [ ] 删除文件后尝试查看信息，验证显示"文件不存在"

#### 数据重置功能

- [ ] 准备测试数据（多个文件、文件夹、分享链接）
- [ ] 打开设置对话框，验证"危险区域"显示正确
- [ ] 点击"重置所有数据"，验证弹出二次确认
- [ ] 点击"取消"，验证数据未被删除
- [ ] 再次点击"重置所有数据"并确认
- [ ] 验证操作完成后显示成功提示
- [ ] 刷新页面，验证所有文件和文件夹已清空
- [ ] 验证分享链接失效
- [ ] 验证站点设置保留（siteName、siteIconUrl 等）

#### 边界情况测试

- [ ] 快速连续点击两次"信息"，验证不崩溃
- [ ] 断开网络后查看信息，验证显示网络错误
- [ ] 在一个标签页删除文件，在另一个标签页查看信息，验证显示错误

### 数据库验证

```bash
# 验证哈希值写入
wrangler d1 execute cloudvault --command "SELECT id, name, sha1, sha256 FROM files LIMIT 5"

# 验证重置后数据清空
wrangler d1 execute cloudvault --command "SELECT COUNT(*) FROM files"
wrangler d1 execute cloudvault --command "SELECT COUNT(*) FROM folders"
```

## 实现顺序

建议按以下顺序实现，以便逐步验证功能：

1. **后端基础设施**
   - [ ] 实现 `src/utils/hash.ts` 哈希计算工具
   - [ ] 在 `src/api/files.ts` 中实现 `info` 函数
   - [ ] 在 `src/router.ts` 中注册 `/api/files/:id/info` 路由
   - [ ] 使用 `curl` 或 Postman 测试 API

2. **前端文件信息功能**
   - [ ] 在 `web/src/api/index.ts` 中实现 `getFileInfo` 函数
   - [ ] 在 `web/src/features/dashboard/Modals.tsx` 中实现 `FileInfoDialog` 组件
   - [ ] 在 `web/src/apps/dashboard.tsx` 中集成到菜单
   - [ ] 测试完整流程

3. **后端数据重置功能**
   - [ ] 创建 `src/api/admin.ts` 文件
   - [ ] 实现 `resetAll` 函数
   - [ ] 在 `src/router.ts` 中注册 `/api/admin/reset-all` 路由
   - [ ] 使用 `curl` 测试 API

4. **前端数据重置功能**
   - [ ] 在 `web/src/api/index.ts` 中实现 `resetAllData` 函数
   - [ ] 在 `web/src/features/dashboard/Modals.tsx` 中增强 `SettingsDialog`
   - [ ] 测试完整流程

5. **完整测试**
   - [ ] 执行所有手动测试清单
   - [ ] 验证数据库状态
   - [ ] 修复发现的问题

## 安全考虑

### 文件信息 API

- **认证要求：** 必须登录才能访问
- **授权检查：** 当前实现中所有登录用户都可以访问所有文件（单用户系统）
- **信息泄露：** 哈希值本身不包含敏感信息，可以安全展示

### 数据重置 API

- **认证要求：** 必须登录才能访问
- **二次确认：** 前端强制要求用户二次确认
- **操作日志：** 建议在后端记录重置操作（可选，当前未实现）
- **权限控制：** 当前实现中所有登录用户都可以重置（单用户系统）

### 潜在风险

1. **哈希计算 DoS**
   - 恶意用户可能频繁请求大文件的哈希计算
   - 缓解措施：哈希值缓存到数据库，后续请求不会重复计算
   - 进一步优化：可以添加速率限制（当前未实现）

2. **数据重置误操作**
   - 用户可能误点击重置按钮
   - 缓解措施：二次确认对话框，明确警告不可撤销
   - 进一步优化：可以要求输入确认文本（如"DELETE"）

## 未来优化方向

### 短期优化（可选）

1. **哈希计算进度反馈**
   - 对于大文件，显示计算进度百分比
   - 需要后端支持流式响应或轮询机制

2. **批量查看信息**
   - 支持选中多个文件后批量查看信息
   - 在一个对话框中展示多个文件的信息

3. **导出文件清单**
   - 将所有文件的信息（包括哈希值）导出为 CSV 或 JSON
   - 用于备份或审计

### 长期优化（可选）

1. **增量哈希计算**
   - 在文件上传时异步计算哈希值
   - 使用 Cloudflare Queues 或 Durable Objects 实现后台任务

2. **多用户权限控制**
   - 限制数据重置功能仅管理员可用
   - 需要实现角色和权限系统

3. **操作审计日志**
   - 记录所有敏感操作（如数据重置）
   - 包括操作时间、操作用户、操作结果等

## 总结

本设计提供了完整的文件信息展示和数据重置功能实现方案，主要特点：

- **符合 Worker 限制：** 使用流式处理避免 CPU 超时
- **性能优化：** 哈希值缓存、批量删除、并行计算
- **用户体验：** 清晰的加载状态、二次确认、友好的错误提示
- **安全可靠：** 认证保护、二次确认、幂等操作

实现完成后，用户将能够：
- 方便地查看文件的详细信息和哈希值
- 安全地重置整个系统，清除所有数据

---

**下一步：** 编写详细的实现计划（implementation plan）
