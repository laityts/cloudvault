# 文件夹统计信息显示设计

**日期：** 2026-05-29  
**状态：** 待审查

## 一、功能概述

在文件管理界面（Dashboard）的文件夹卡片和列表行中，显示每个文件夹的直接子文件夹数量和直接文件数量，以图标+数字的紧凑形式呈现，提升用户对文件夹内容的感知。

## 二、需求规格

### 2.1 统计规则

- **子文件夹数（subfolderCount）**：该文件夹下一层的文件夹个数（不递归计算子孙文件夹）
- **文件数（fileCount）**：直接位于该文件夹内的文件个数（不包含子文件夹内的文件）
- **零值处理**：当某项统计为 0 时，不显示该项（减少视觉噪音）

**示例：**
```
文件夹结构：
  照片/
    ├── 2024/
    │   ├── img1.jpg
    │   └── img2.jpg
    ├── 2025/
    └── cover.png

统计结果：
  照片: subfolderCount=2, fileCount=1
  照片/2024: subfolderCount=0, fileCount=2
  照片/2025: subfolderCount=0, fileCount=0
```

### 2.2 显示位置

- **卡片视图（`FolderCard`）**：底部左侧，替换现有的"文件夹"文字
- **列表视图（`FolderRow`）**：类型列（第三列），替换现有的"文件夹" pill

### 2.3 视觉样式

使用小图标 + 数字的形式，横向排列：
- 文件夹图标（`IconFolder`, size=11）+ 数字（子文件夹数）
- 文件图标（`IconFile`, size=11）+ 数字（文件数）
- 字号：11px
- 颜色：`text-fg-muted`
- 间距：图标与数字之间 0.5 单位，两组之间 1.5 单位
- 样式与现有的分享图标保持一致

**视觉示例：**
```
卡片底部：
  📁 3  📄 12

列表类型列：
  📁 3  📄 12
```

## 三、技术实现

### 3.1 数据来源

**方案：后端聚合计算**

在 `listFolders` API 中，后端已经全量加载 `allFiles` 和 `folderRecords`，在返回前进行一次聚合计算，将统计值附加到每个 `FolderInfo` 对象中。

**优势：**
- 零额外请求，数据随现有 API 返回
- 后端聚合成本极低（已有全量数据）
- 前端无需额外计算逻辑

### 3.2 后端改动

#### 文件：`src/api/folders.ts`

在 `listFolders` 函数中，现有逻辑已经获取了：
```typescript
const [allFiles, folderRecords, sharedFolders, excludedFolders] = await Promise.all([
  listAllFiles(env),
  listAllFolders(env),
  getSharedFolders(env),
  getExcludedFolders(env),
]);
```

**新增聚合逻辑：**

1. **统计每个文件夹的直接文件数：**
   ```typescript
   const fileCountMap = new Map<string, number>();
   for (const file of allFiles) {
     const folder = file.folder || 'root';
     fileCountMap.set(folder, (fileCountMap.get(folder) || 0) + 1);
   }
   ```

2. **统计每个文件夹的直接子文件夹数：**
   ```typescript
   const subfolderCountMap = new Map<string, number>();
   for (const folderPath of folderSet) {
     const parentPath = folderPath.includes('/')
       ? folderPath.substring(0, folderPath.lastIndexOf('/'))
       : 'root';
     subfolderCountMap.set(parentPath, (subfolderCountMap.get(parentPath) || 0) + 1);
   }
   ```

3. **在返回的 `folderList` 中附加统计值：**
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

#### 文件：`web/src/api/types.ts`

更新 `FolderInfo` 接口：
```typescript
export interface FolderInfo {
  name: string;
  shared: boolean;
  directlyShared: boolean;
  excluded: boolean;
  subfolderCount?: number;  // 新增
  fileCount?: number;        // 新增
}
```

### 3.3 前端改动

#### 文件：`web/src/features/dashboard/FileViews.tsx`

**`FolderCard` 组件改动：**

当前底部左侧代码（第 93-100 行）：
```tsx
<div class="flex items-center justify-between mt-0.5 text-[11px] text-fg-muted">
  <span>文件夹</span>
  <Show when={props.folder.shared || props.folder.directlyShared}>
    <span class="text-brand inline-flex items-center gap-0.5" title={...}>
      <IconShare size={10} />
    </span>
  </Show>
</div>
```

改为：
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
    <span class="text-brand inline-flex items-center gap-0.5" title={...}>
      <IconShare size={10} />
    </span>
  </Show>
</div>
```

**`FolderRow` 组件改动：**

当前类型列代码（第 295-296 行）：
```tsx
<span class="hidden md:flex">
  <span class="pill">文件夹</span>
</span>
```

改为：
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

**图标导入：**

在文件顶部导入语句中添加 `IconFile`（如果尚未导入）：
```typescript
import { FileIcon, IconCheck, IconLink, IconChevronUp, IconChevronDown, 
         IconMoreVertical, IconChevronRight, IconShare, IconFolder, IconFile } from '~/ui';
```

## 四、边界情况处理

| 场景 | subfolderCount | fileCount | 显示结果 |
|------|----------------|-----------|----------|
| 空文件夹 | 0 | 0 | 不显示任何统计（区域留空） |
| 只有子文件夹 | > 0 | 0 | 只显示 `📁 N` |
| 只有文件 | 0 | > 0 | 只显示 `📄 N` |
| 两者都有 | > 0 | > 0 | 显示 `📁 N  📄 M` |
| root 文件夹 | N/A | N/A | Home 行不显示统计（保持现状） |

## 五、验证方式

### 5.1 后端验证

1. 调用 `GET /api/folders`，检查返回的 JSON
2. 确认每个 `FolderInfo` 对象包含 `subfolderCount` 和 `fileCount` 字段
3. 手动验证几个文件夹的统计值是否准确

**验证命令：**
```bash
curl -H "Authorization: Bearer <token>" http://localhost:8787/api/folders | jq '.folders[] | {name, subfolderCount, fileCount}'
```

### 5.2 前端验证

1. **视觉检查：**
   - 在卡片视图和列表视图中检查文件夹显示
   - 确认图标+数字样式与设计一致
   - 确认零值项正确隐藏

2. **功能测试：**
   - 创建空文件夹，确认不显示统计
   - 上传文件到文件夹，确认文件数正确
   - 创建子文件夹，确认子文件夹数正确
   - 删除文件/文件夹，确认统计更新

3. **响应式测试：**
   - 桌面端：列表视图的类型列正确显示统计
   - 移动端：列表视图的类型列隐藏（保持现有行为）

## 六、性能影响

- **后端：** 聚合计算复杂度 O(n)，n 为文件+文件夹总数。对于千级规模的数据，耗时 < 10ms，可忽略。
- **前端：** 零额外请求，渲染逻辑简单（条件显示），性能影响可忽略。
- **网络：** 每个 `FolderInfo` 增加约 20 字节（两个数字字段），对于百级文件夹，总增量 < 2KB。

## 七、未来扩展

如果后续需要支持"递归统计"（显示文件夹及其所有子孙文件夹的总文件数），可以：
1. 在后端增加 `totalFileCount` 字段（递归计算）
2. 前端增加切换选项或 tooltip 显示详细统计
3. 当前设计无需修改，只需扩展字段

## 八、实现清单

- [ ] 后端：修改 `src/api/folders.ts` 的 `listFolders` 函数，添加聚合逻辑
- [ ] 类型：更新 `web/src/api/types.ts` 的 `FolderInfo` 接口
- [ ] 前端：修改 `web/src/features/dashboard/FileViews.tsx` 的 `FolderCard` 组件
- [ ] 前端：修改 `web/src/features/dashboard/FileViews.tsx` 的 `FolderRow` 组件
- [ ] 前端：确保 `IconFile` 已导入
- [ ] 验证：后端 API 返回正确统计值
- [ ] 验证：前端卡片视图显示正确
- [ ] 验证：前端列表视图显示正确
- [ ] 验证：零值处理正确
- [ ] 验证：响应式布局正常
