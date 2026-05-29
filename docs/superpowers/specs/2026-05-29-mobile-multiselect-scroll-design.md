# 移动端多选与文件区滚动设计

日期：2026-05-29
范围：仅前端（`web/`），不涉及后端与数据库。

## 背景与问题

仪表盘（`web/src/apps/dashboard.tsx`、`web/src/features/dashboard/FileViews.tsx`）在移动端存在三个互相关联的体验问题：

1. **文件区无法上下滑动**：移动端文件较多时，手指在文件列表/网格区上下滑动无反应，看不到下方文件。
2. **网格视图无法勾选文件**：移动端处于网格视图时找不到任何勾选入口。
3. **缺少「全选」入口**：全选目前只有桌面列表视图表头复选框（`FileViews.tsx:236`）与 `Ctrl/Cmd+A`（`dashboard.tsx:232`），网格视图与移动端没有入口。

底层的选择能力（`selectAll / toggleSelect / selectRange / clearSelection`）已在 `web/src/features/dashboard/store.ts` 中存在，本设计只补齐入口与修复布局，不新增 store 逻辑。

## 目标

- 移动端文件列表/网格区可正常上下滚动。
- 移动端网格视图可勾选文件并进入多选。
- 提供覆盖所有视图与所有端的「全选 / 取消全选」入口。

## 非目标（YAGNI）

- 不改动 `store.ts` 的选择算法（复用现有 `selectAll` / `clearSelection`）。
- 不引入长按进入多选的新手势（与现有「长按 = 打开操作菜单」冲突，不在本次范围）。
- 不改桌面端既有交互（列表表头全选、`Ctrl/Cmd+A`、hover 显示勾选框保持不变）。
- 不改后端、不改子文件夹选择（子文件夹无选择概念，全选仅作用于文件）。

## 设计

### 1. 修复移动端文件区无法滚动（布局）

**根因**：根容器使用 `min-h-dvh`（`dashboard.tsx:402`，无固定高度上限），且 `<main>`（`dashboard.tsx:475`）缺 `min-h-0`。这使内容区 `overflow-y-auto`（`dashboard.tsx:592`）的高度被内容撑满——它作为独立滚动容器「吞掉」触摸滚动事件，自身却无需滚动，导致整页无法滑动。桌面端文件少时不溢出，故未暴露。

**改法（2 处，纯布局）**：

- `dashboard.tsx:402`：根容器 `min-h-dvh flex flex-col` → `h-dvh flex flex-col`（建立固定高度的滚动根）。
- `dashboard.tsx:475`：`<main class="flex-1 flex flex-col min-w-0">` → 增加 `min-h-0`。

效果：顶部操作栏、批量操作栏固定，仅内容区 `overflow-y-auto` 滚动；移动端可正常上下滑。这是更标准的 dashboard 高度链，桌面端只会更正确（侧栏与内容区各自独立滚动）。

### 2. 移动端网格视图可勾选（点选即进入多选）

**根因**：网格卡片勾选框为 `opacity-0 group-hover:opacity-100`（`FileViews.tsx:165`），移动端无 hover 故永不显示。

**改法**：勾选框改为「移动端常显、桌面端 hover 显示」，已选中 / 多选模式下各端仍常显（复用现有 `(selectionMode() || selected()) && 'opacity-100'` 逻辑）。

`FileViews.tsx:165` 未选中态样式：

```diff
- 'bg-bg-surface/85 border-line opacity-0 group-hover:opacity-100'
+ 'bg-bg-surface/85 border-line opacity-100 md:opacity-0 md:group-hover:opacity-100'
```

移动端勾选框始终可见，点击即 `toggleSelect` 进入多选模式（点击 handler 已 `stopPropagation`，不会误触发预览）。桌面端行为不变。

### 3. 批量操作栏增加「全选 / 取消全选」

在批量操作栏（已选 >0 时显示，`dashboard.tsx:560`）的「取消」与「打包下载」之间，增加一个按钮：

- 当前页文件未全部选中 → 显示「全选」，点击 `store.selectAll()`。
- 当前页文件已全部选中 → 显示「取消全选」，点击 `store.clearSelection()`。

判定是否已全选（仅针对当前 `filteredFiles`，与列表表头全选语义一致）：

```jsx
const allSelected = () =>
  store.filteredFiles().length > 0 &&
  store.filteredFiles().every((f) => store.isSelected(f.id));
```

按钮（沿用操作栏现有 `Button variant="ghost" size="xs"` 风格）：

```jsx
<Button
  variant="ghost"
  size="xs"
  onClick={() => (allSelected() ? store.clearSelection() : store.selectAll())}
>
  {allSelected() ? '取消全选' : '全选'}
</Button>
```

入口对所有视图（网格 / 列表）与所有端生效。进入多选（点任一勾选框）后，操作栏出现，再点「全选」即可。

## 数据流与一致性

- 进入多选：移动端点网格/列表勾选框 → `toggleSelect` → `selected().size > 0` → 批量操作栏出现。
- 「全选」作用于 `filteredFiles()`（当前文件夹 + 类型过滤后的文件），与桌面列表表头全选框语义一致；切换文件夹时 `setCurrentFolder` 已清空选择。
- 桌面端列表表头全选框、`Ctrl/Cmd+A`、`Esc` 清空、hover 显示勾选框等既有交互均不改动。

## 验证（§13 非真机）

- `npm run typecheck` 通过（后端 `tsc` + 前端 `web/tsconfig.json`）。
- `npm run build:web`（vite 构建）通过，确认编译无误。
- 以逻辑推理确认：固定高度链使内容区成为受限滚动容器（移动端可滑）；网格勾选框移动端常显且点击进入多选；全选按钮在两种视图、两端均生效，文案随是否全选切换。
- 不在真实浏览器 / 设备上运行验证。
