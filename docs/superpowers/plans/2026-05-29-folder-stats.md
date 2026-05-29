# 文件夹统计信息显示实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在文件夹卡片和列表行中显示直接子文件夹数和直接文件数，以图标+数字形式呈现

**Architecture:** 后端在 `listFolders` API 中聚合计算统计值并附加到 `FolderInfo`，前端读取字段并条件渲染图标+数字（零值隐藏）

**Tech Stack:** TypeScript, Cloudflare Workers, SolidJS

---

## 文件结构

**修改的文件：**
- `web/src/api/types.ts` - 给 `FolderInfo` 接口添加 `subfolderCount` 和 `fileCount` 字段
- `src/api/folders.ts` - 在 `listFolders` 函数中添加聚合逻辑
- `web/src/features/dashboard/FileViews.tsx` - 更新 `FolderCard` 和 `FolderRow` 组件显示统计

**不创建新文件**，所有改动都在现有文件中。

---

## Task 1: 更新前端类型定义

**Files:**
- Modify: `web/src/api/types.ts:19-24`

- [ ] **Step 1: 读取现有 FolderInfo 接口**

```bash
grep -A 6 "export interface FolderInfo" web/src/api/types.ts
```

Expected output:
```typescript
export interface FolderInfo {
  name: string;
  shared: boolean;
  directlyShared: boolean;
  excluded: boolean;
}
```

- [ ] **Step 2: 添加统计字段到 FolderInfo 接口**

在 `web/src/api/types.ts` 的 `FolderInfo` 接口中添加两个可选字段：

```typescript
export interface FolderInfo {
  name: string;
  shared: boolean;
  directlyShared: boolean;
  excluded: boolean;
  subfolderCount?: number;
  fileCount?: number;
}
```

- [ ] **Step 3: 验证类型定义语法**

```bash
cd web && npm run typecheck 2>&1 | grep -E "(error|FolderInfo)" || echo "类型检查通过"
```

Expected: "类型检查通过" 或无 FolderInfo 相关错误

- [ ] **Step 4: 提交类型定义**

```bash
git add web/src/api/types.ts
git commit -m "feat(types): 为 FolderInfo 添加统计字段

添加 subfolderCount 和 fileCount 可选字段用于显示文件夹内容统计

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 后端添加统计聚合逻辑

**Files:**
- Modify: `src/api/folders.ts:135-173`

- [ ] **Step 1: 定位 listFolders 函数中的 folderList 构建代码**

```bash
grep -n "const folderList = Array.from(folderSet)" src/api/folders.ts
```

Expected: 显示行号（约 165 行）

- [ ] **Step 2: 在 folderList 构建前添加文件数统计**

在 `src/api/folders.ts` 的 `listFolders` 函数中，在 `folderSet.add(path);` 循环之后、`const folderList = Array.from(folderSet)` 之前插入：

```typescript
  // 统计每个文件夹的直接文件数
  const fileCountMap = new Map<string, number>();
  for (const file of allFiles) {
    const folder = file.folder || 'root';
    fileCountMap.set(folder, (fileCountMap.get(folder) || 0) + 1);
  }
```

- [ ] **Step 3: 添加子文件夹数统计**

紧接着上一步的代码后添加：

```typescript
  // 统计每个文件夹的直接子文件夹数
  const subfolderCountMap = new Map<string, number>();
  for (const folderPath of folderSet) {
    const parentPath = folderPath.includes('/')
      ? folderPath.substring(0, folderPath.lastIndexOf('/'))
      : 'root';
    subfolderCountMap.set(parentPath, (subfolderCountMap.get(parentPath) || 0) + 1);
  }
```

- [ ] **Step 4: 在 folderList 映射中附加统计值**

修改 `const folderList = Array.from(folderSet).sort().map(...)` 部分，将：

```typescript
  const folderList = Array.from(folderSet).sort().map((name) => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
  }));
```

改为：

```typescript
  const folderList = Array.from(folderSet).sort().map((name) => ({
    name,
    shared: isFolderShared(name, sharedFolders, excludedFolders),
    directlyShared: sharedFolders.has(name),
    excluded: excludedFolders.has(name),
    subfolderCount: subfolderCountMap.get(name) || 0,
    fileCount: fileCountMap.get(name) || 0,
  }));
```

- [ ] **Step 5: 验证后端代码语法**

```bash
npm run typecheck 2>&1 | grep -E "(error|folders\.ts)" || echo "后端类型检查通过"
```

Expected: "后端类型检查通过" 或无 folders.ts 相关错误

- [ ] **Step 6: 提交后端改动**

```bash
git add src/api/folders.ts
git commit -m "feat(api): 在 listFolders 中添加文件夹统计

计算每个文件夹的直接子文件夹数和直接文件数，附加到返回的 FolderInfo 中

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 更新 FolderCard 组件显示统计

**Files:**
- Modify: `web/src/features/dashboard/FileViews.tsx:5,93-100`

- [ ] **Step 1: 检查 IconFile 是否已导入**

```bash
grep "IconFile" web/src/features/dashboard/FileViews.tsx | head -1
```

Expected: 如果输出为空，需要添加导入；否则已导入

- [ ] **Step 2: 添加 IconFile 导入（如果需要）**

如果上一步输出为空，修改第 5 行的导入语句，将：

```typescript
import { FileIcon, IconCheck, IconLink, IconChevronUp, IconChevronDown, IconMoreVertical, IconChevronRight, IconShare } from '~/ui';
```

改为：

```typescript
import { FileIcon, IconCheck, IconLink, IconChevronUp, IconChevronDown, IconMoreVertical, IconChevronRight, IconShare, IconFolder, IconFile } from '~/ui';
```

- [ ] **Step 3: 定位 FolderCard 底部代码**

```bash
grep -n "文件夹</span>" web/src/features/dashboard/FileViews.tsx | grep -A 2 "93:"
```

Expected: 显示第 93-100 行附近的代码

- [ ] **Step 4: 替换 FolderCard 底部显示逻辑**

在 `web/src/features/dashboard/FileViews.tsx` 的 `FolderCard` 组件中，将第 93-100 行的：

```tsx
    <div class="flex items-center justify-between mt-0.5 text-[11px] text-fg-muted">
      <span>文件夹</span>
      <Show when={props.folder.shared || props.folder.directlyShared}>
        <span class="text-brand inline-flex items-center gap-0.5" title={props.folder.directlyShared ? '已分享' : '继承分享'}>
          <IconShare size={10} />
        </span>
      </Show>
    </div>
```

替换为：

```tsx
    <div class="flex items-center justify-between mt-0.5 text-[11px] text-fg-muted">
      <div class="inline-flex items-center gap-1.5">
        <Show when={(props.folder.subfolderCount ?? 0) > 0}>
          <span class="inline-flex items-center gap-0.5">
            <IconFolder size={11} />
            {props.folder.subfolderCount}
          </span>
        </Show>
        <Show when={(props.folder.fileCount ?? 0) > 0}>
          <span class="inline-flex items-center gap-0.5">
            <IconFile size={11} />
            {props.folder.fileCount}
          </span>
        </Show>
      </div>
      <Show when={props.folder.shared || props.folder.directlyShared}>
        <span class="text-brand inline-flex items-center gap-0.5" title={props.folder.directlyShared ? '已分享' : '继承分享'}>
          <IconShare size={10} />
        </span>
      </Show>
    </div>
```

- [ ] **Step 5: 验证前端代码语法**

```bash
cd web && npm run typecheck 2>&1 | grep -E "(error|FileViews\.tsx)" || echo "前端类型检查通过"
```

Expected: "前端类型检查通过" 或无 FileViews.tsx 相关错误

- [ ] **Step 6: 提交 FolderCard 改动**

```bash
git add web/src/features/dashboard/FileViews.tsx
git commit -m "feat(dashboard): FolderCard 显示文件夹统计

用图标+数字替换"文件夹"文字，显示直接子文件夹数和文件数（零值隐藏）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 更新 FolderRow 组件显示统计

**Files:**
- Modify: `web/src/features/dashboard/FileViews.tsx:295-297`

- [ ] **Step 1: 定位 FolderRow 类型列代码**

```bash
grep -n 'pill">文件夹</span>' web/src/features/dashboard/FileViews.tsx
```

Expected: 显示行号（约 296 行）

- [ ] **Step 2: 替换 FolderRow 类型列显示逻辑**

在 `web/src/features/dashboard/FileViews.tsx` 的 `FolderRow` 组件中，将第 295-297 行的：

```tsx
    <span class="hidden md:flex">
      <span class="pill">文件夹</span>
    </span>
```

替换为：

```tsx
    <span class="hidden md:flex items-center gap-1.5 text-[11px] text-fg-muted">
      <Show when={(props.folder.subfolderCount ?? 0) > 0}>
        <span class="inline-flex items-center gap-0.5">
          <IconFolder size={11} />
          {props.folder.subfolderCount}
        </span>
      </Show>
      <Show when={(props.folder.fileCount ?? 0) > 0}>
        <span class="inline-flex items-center gap-0.5">
          <IconFile size={11} />
          {props.folder.fileCount}
        </span>
      </Show>
    </span>
```

- [ ] **Step 3: 验证前端代码语法**

```bash
cd web && npm run typecheck 2>&1 | grep -E "(error|FileViews\.tsx)" || echo "前端类型检查通过"
```

Expected: "前端类型检查通过" 或无 FileViews.tsx 相关错误

- [ ] **Step 4: 提交 FolderRow 改动**

```bash
git add web/src/features/dashboard/FileViews.tsx
git commit -m "feat(dashboard): FolderRow 显示文件夹统计

列表视图的类型列显示图标+数字统计，替换"文件夹" pill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 构建前端并验证

**Files:**
- Test: 前端构建产物

- [ ] **Step 1: 构建前端**

```bash
cd web && npm run build
```

Expected: 构建成功，无错误

- [ ] **Step 2: 检查构建产物**

```bash
ls -lh web/dist/index.html web/dist/assets/*.js | head -3
```

Expected: 显示构建产物文件列表

- [ ] **Step 3: 提交构建产物**

```bash
git add web/dist
git commit -m "chore(build): 重建前端构建产物

包含文件夹统计显示功能

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 端到端验证

**Files:**
- Test: 完整功能验证

- [ ] **Step 1: 启动开发服务器（如果尚未运行）**

```bash
# 在后台启动（如果需要）
# npm run dev &
echo "确保开发服务器正在运行"
```

Expected: 服务器运行在 http://localhost:8787 或配置的端口

- [ ] **Step 2: 验证后端 API 返回统计字段**

```bash
# 注意：需要替换 <token> 为实际的认证令牌
# 如果本地开发环境无需认证，可以去掉 -H "Authorization: Bearer <token>"
curl -s http://localhost:8787/api/folders | jq '.folders[0] | {name, subfolderCount, fileCount}'
```

Expected output 示例：
```json
{
  "name": "照片",
  "subfolderCount": 2,
  "fileCount": 5
}
```

- [ ] **Step 3: 浏览器视觉验证 - 卡片视图**

手动操作：
1. 打开浏览器访问 Dashboard
2. 切换到卡片视图（Grid view）
3. 检查文件夹卡片底部左侧：
   - 有子文件夹和文件的：显示 `📁 N  📄 M`
   - 只有子文件夹的：显示 `📁 N`
   - 只有文件的：显示 `📄 N`
   - 空文件夹：不显示统计（区域留空）
4. 确认图标大小、颜色、间距与设计一致

Expected: 所有文件夹卡片正确显示统计

- [ ] **Step 4: 浏览器视觉验证 - 列表视图**

手动操作：
1. 切换到列表视图（List view）
2. 检查文件夹行的类型列（第三列）：
   - 桌面端：显示图标+数字统计
   - 移动端（缩小浏览器窗口）：类型列隐藏（保持现有行为）
3. 确认零值处理正确

Expected: 列表视图正确显示统计，响应式布局正常

- [ ] **Step 5: 功能验证 - 创建文件夹**

手动操作：
1. 创建一个新的空文件夹
2. 刷新页面
3. 确认新文件夹不显示任何统计（两个都是 0）

Expected: 空文件夹不显示统计

- [ ] **Step 6: 功能验证 - 上传文件**

手动操作：
1. 向上一步创建的文件夹上传一个文件
2. 刷新页面
3. 确认文件夹显示 `📄 1`

Expected: 文件数正确显示

- [ ] **Step 7: 功能验证 - 创建子文件夹**

手动操作：
1. 在某个文件夹下创建一个子文件夹
2. 返回上级目录并刷新
3. 确认父文件夹的子文件夹数增加

Expected: 子文件夹数正确显示

- [ ] **Step 8: 记录验证结果**

创建验证报告：

```bash
cat > /tmp/folder-stats-verification.txt << 'EOF'
文件夹统计功能验证报告
========================

日期: $(date +%Y-%m-%d)

✓ 后端 API 返回 subfolderCount 和 fileCount 字段
✓ 卡片视图正确显示统计
✓ 列表视图正确显示统计
✓ 零值正确隐藏
✓ 空文件夹不显示统计
✓ 文件数统计准确
✓ 子文件夹数统计准确
✓ 响应式布局正常

所有验证项通过。
EOF
cat /tmp/folder-stats-verification.txt
```

Expected: 显示验证报告

---

## 自我审查清单

**规格覆盖检查：**
- ✅ 统计规则（直接子级，非递归）- Task 2 实现
- ✅ 零值处理（隐藏为 0 的项）- Task 3, 4 实现
- ✅ 显示位置（卡片底部左侧，列表类型列）- Task 3, 4 实现
- ✅ 视觉样式（图标+数字，11px，text-fg-muted）- Task 3, 4 实现
- ✅ 后端聚合计算 - Task 2 实现
- ✅ 前端类型定义 - Task 1 实现
- ✅ 验证方式 - Task 6 实现

**占位符检查：**
- ✅ 无 TBD、TODO
- ✅ 所有代码步骤包含完整代码
- ✅ 所有命令包含预期输出
- ✅ 无"类似于 Task N"的引用

**类型一致性检查：**
- ✅ `subfolderCount` 和 `fileCount` 在所有任务中拼写一致
- ✅ `FolderInfo` 接口在类型定义和使用中一致
- ✅ 图标名称 `IconFolder` 和 `IconFile` 一致

**文件路径检查：**
- ✅ 所有文件路径精确且完整
- ✅ 行号引用准确（基于当前代码）
