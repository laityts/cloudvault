# 移动端多选与文件区滚动实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复移动端文件区无法上下滑动、网格视图无法勾选两个 bug，并在批量操作栏增加「全选 / 取消全选」按钮。

**Architecture:** 三处独立、纯前端、纯展现层改动。布局上修复 dashboard 根容器与 `<main>` 的高度链；样式上将网格勾选框从 hover 显示改为「移动端常显、桌面 hover」；批量操作栏复用 store 已有的 `selectAll / clearSelection` 接入「全选」入口。

**Tech Stack:** TypeScript, SolidJS, TailwindCSS, Vite

**项目无前端测试框架与真机验证（CLAUDE.md §13）。** 每个任务的「验证」步骤只跑 `npm run typecheck` 与 `npm run build:web`，并在步骤内做静态/逻辑推演确认改动符合 spec。

参考 spec：`docs/superpowers/specs/2026-05-29-mobile-multiselect-scroll-design.md`

---

## 文件结构

**修改的文件：**
- `web/src/apps/dashboard.tsx` — 修复根容器 / `<main>` 高度链；批量操作栏新增「全选 / 取消全选」按钮。
- `web/src/features/dashboard/FileViews.tsx` — 修改网格卡片勾选框 className（移动端常显、桌面 hover）。

**不创建新文件**，不改 `store.ts`、不改后端、不改 CSS tokens。

---

## Task 1: 修复移动端文件区无法上下滑动（布局高度链）

**Files:**
- Modify: `web/src/apps/dashboard.tsx:402` (根容器)
- Modify: `web/src/apps/dashboard.tsx:475` (`<main>`)

- [ ] **Step 1: 确认根容器与 `<main>` 的当前 className**

Run:
```bash
sed -n '402p;475p' web/src/apps/dashboard.tsx
```

Expected output (注意行号缩进，无需匹配空白)：
```tsx
    <div class="min-h-dvh flex flex-col bg-bg-base">
        <main class="flex-1 flex flex-col min-w-0">
```

如行号已偏移，先 `grep -n 'min-h-dvh flex flex-col bg-bg-base' web/src/apps/dashboard.tsx` 与 `grep -n 'flex-1 flex flex-col min-w-0' web/src/apps/dashboard.tsx` 定位。

- [ ] **Step 2: 把根容器 `min-h-dvh` 改为 `h-dvh`**

将 `web/src/apps/dashboard.tsx` 中下面这行：

```tsx
    <div class="min-h-dvh flex flex-col bg-bg-base">
```

改为：

```tsx
    <div class="h-dvh flex flex-col bg-bg-base">
```

原因：`min-h-dvh` 只设置最小高度，内容可以撑到比视口更高，导致里层 `overflow-y-auto`（`dashboard.tsx:592`）的高度也被撑满、自身无需滚动，触摸滚动事件被它吞掉。`h-dvh` 锁定为视口高度，里层滚动容器才会受限并真正滚动。

- [ ] **Step 3: 给 `<main>` 加 `min-h-0`**

将下面这行：

```tsx
        <main class="flex-1 flex flex-col min-w-0">
```

改为：

```tsx
        <main class="flex-1 flex flex-col min-w-0 min-h-0">
```

原因：flex 子项默认 `min-height: auto`，会以内容高度为下界、忽略 `flex-1` 的高度收缩，使内部 `overflow-y-auto` 容器同样被撑满。加 `min-h-0` 才能让 `<main>` 真正按 flex 比例收缩，把多余高度交给内部滚动容器。

- [ ] **Step 4: 跑类型检查与构建**

Run:
```bash
npm run typecheck && npm run build:web
```

Expected: 全部通过，无 TS 错误、无构建错误。

- [ ] **Step 5: 逻辑核对 (非真机)**

- 根 `h-dvh` → `<div>` 高度 = 视口高度。
- 里面是 `flex flex-col`：`<header>`（固定高度 `h-13`）+ `<div class="flex-1 flex min-h-0">`（侧栏 + main）。
- 该外层 `flex-1` 已有 `min-h-0`（`dashboard.tsx:444`），自身可收缩 ✓。
- `<main class="flex-1 flex flex-col min-w-0 min-h-0">` 现在也可收缩，剩余高度分配给内部各子节点。
- 内部 `<div class="flex-1 overflow-y-auto p-3 sm:p-4 pb-24 md:pb-4">`（`dashboard.tsx:592`）成为受限滚动容器，移动端可正常上下滑。
- 桌面端只会更正确：侧栏 `overflow-y-auto`（`dashboard.tsx:447`）与内容区各自独立滚动。

- [ ] **Step 6: 提交**

Run:
```bash
git add web/src/apps/dashboard.tsx
git commit -m "fix(web): 修正 dashboard 高度链使移动端文件区可滚动

根容器 min-h-dvh 让内容可撑超视口、main 缺 min-h-0 让 flex
子项不收缩，导致内层 overflow-y-auto 的高度被撑满、自身无需
滚动而吞掉触摸事件。改为 h-dvh + main 加 min-h-0,锁定视口
高度,让内容区成为受限滚动容器。"
```

---

## Task 2: 网格卡片勾选框移动端常显（修复网格视图在移动端无法勾选）

**Files:**
- Modify: `web/src/features/dashboard/FileViews.tsx:165`

- [ ] **Step 1: 确认网格卡片勾选框的当前 className**

Run:
```bash
sed -n '160,170p' web/src/features/dashboard/FileViews.tsx
```

Expected output 含有 (关注下面这一行)：
```tsx
            : 'bg-bg-surface/85 border-line opacity-0 group-hover:opacity-100',
```

如行号偏移，用 `grep -n "bg-bg-surface/85 border-line opacity-0 group-hover:opacity-100" web/src/features/dashboard/FileViews.tsx` 定位。

- [ ] **Step 2: 改 className：移动端常显、桌面端 hover 显示**

将该行：

```tsx
            : 'bg-bg-surface/85 border-line opacity-0 group-hover:opacity-100',
```

改为：

```tsx
            : 'bg-bg-surface/85 border-line opacity-100 md:opacity-0 md:group-hover:opacity-100',
```

原因：原写法 `opacity-0 group-hover:opacity-100` 在没有 hover 的触屏设备上永不显示，导致移动端网格视图无任何勾选入口。新写法默认 `opacity-100`（移动端常显），`md:` 断点起恢复桌面端 hover 行为。已选中 / 多选模式下两端继续常显，由同 className 列表后面的 `(selectionMode() || selected()) && 'opacity-100'` 兜底（`FileViews.tsx:166`，本步不动）。

- [ ] **Step 3: 跑类型检查与构建**

Run:
```bash
npm run typecheck && npm run build:web
```

Expected: 全部通过。

- [ ] **Step 4: 逻辑核对 (非真机)**

- 未选中、未进入多选：移动端勾选框 `opacity-100` 始终可见；桌面端 `md:opacity-0` 隐藏，`md:group-hover:opacity-100` 在 hover 时显示。
- 已选中或 `selectionMode()` 为 true：尾部 `(selectionMode() || selected()) && 'opacity-100'` 覆盖，两端皆常显。
- 点击勾选框 onClick 已 `stopPropagation()`（`FileViews.tsx:158`），并调用 `props.store.toggleSelect(props.file.id)`，进入多选模式；卡片本身 onClick 在 `selectionMode()` 为 true 时也走 `toggleSelect`（`FileViews.tsx:126-133`），交互一致。

- [ ] **Step 5: 提交**

Run:
```bash
git add web/src/features/dashboard/FileViews.tsx
git commit -m "fix(web): 网格卡片勾选框在移动端常显

原 opacity-0 group-hover:opacity-100 在无 hover 的触屏设备上
永不显示,导致移动端网格视图无法勾选文件。改为 opacity-100
md:opacity-0 md:group-hover:opacity-100,移动端常显、桌面端
保持 hover 行为。"
```

---

## Task 3: 批量操作栏新增「全选 / 取消全选」按钮

**Files:**
- Modify: `web/src/apps/dashboard.tsx:560-589` (Bulk action bar 区块)

- [ ] **Step 1: 确认批量操作栏当前结构**

Run:
```bash
sed -n '559,590p' web/src/apps/dashboard.tsx
```

Expected output 含有 (核心定位行)：
```tsx
          <Show when={store.selected().size > 0}>
            <div class="flex items-center gap-2 px-3 sm:px-4 py-2 bg-brand-soft border-b border-brand/20 text-[13px]">
              <span class="font-medium text-brand tabular">已选 {store.selected().size} 项</span>
              <span class="flex-1" />
              <Button variant="ghost" size="xs" onClick={() => store.clearSelection()}>
                取消
              </Button>
              <Button variant="ghost" size="xs" leadingIcon={<IconDownload size={12} />} onClick={downloadZip}>
```

如行号偏移，用 `grep -n '已选 {store.selected().size} 项' web/src/apps/dashboard.tsx` 定位整个块。

- [ ] **Step 2: 在「取消」与「打包下载」之间插入「全选 / 取消全选」按钮**

将这段（`dashboard.tsx:560-588` 范围内）：

```tsx
          <Show when={store.selected().size > 0}>
            <div class="flex items-center gap-2 px-3 sm:px-4 py-2 bg-brand-soft border-b border-brand/20 text-[13px]">
              <span class="font-medium text-brand tabular">已选 {store.selected().size} 项</span>
              <span class="flex-1" />
              <Button variant="ghost" size="xs" onClick={() => store.clearSelection()}>
                取消
              </Button>
              <Button variant="ghost" size="xs" leadingIcon={<IconDownload size={12} />} onClick={downloadZip}>
                <span class="hidden sm:inline">打包下载</span>
              </Button>
```

替换为：

```tsx
          <Show when={store.selected().size > 0}>
            <div class="flex items-center gap-2 px-3 sm:px-4 py-2 bg-brand-soft border-b border-brand/20 text-[13px]">
              <span class="font-medium text-brand tabular">已选 {store.selected().size} 项</span>
              <span class="flex-1" />
              <Button variant="ghost" size="xs" onClick={() => store.clearSelection()}>
                取消
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const files = store.filteredFiles();
                  const allSelected =
                    files.length > 0 && files.every((f) => store.isSelected(f.id));
                  if (allSelected) store.clearSelection();
                  else store.selectAll();
                }}
              >
                {(() => {
                  const files = store.filteredFiles();
                  const allSelected =
                    files.length > 0 && files.every((f) => store.isSelected(f.id));
                  return allSelected ? '取消全选' : '全选';
                })()}
              </Button>
              <Button variant="ghost" size="xs" leadingIcon={<IconDownload size={12} />} onClick={downloadZip}>
                <span class="hidden sm:inline">打包下载</span>
              </Button>
```

说明：
- 复用 store 已有 `selectAll()`（其内部 `setSelected(new Set(filteredFiles().map(f => f.id)))`，与本按钮判断 `allSelected` 的范围一致，均针对 `filteredFiles()`）与 `clearSelection()`。
- 按钮文案在「全选 ↔ 取消全选」间切换，行为对所有视图（网格 / 列表）与所有端（桌面 / 移动）统一生效。
- 用立即执行函数读 `store.filteredFiles()` 与 `store.selected()` 是为了在 SolidJS 响应式 tracking 中正确订阅信号（每次 `selected` / `filteredFiles` 变化都会重算文案与 disabled 状态）。
- 不引入新 import；`Button` 已在文件顶部 import。

- [ ] **Step 3: 跑类型检查与构建**

Run:
```bash
npm run typecheck && npm run build:web
```

Expected: 全部通过。

- [ ] **Step 4: 逻辑核对 (非真机)**

- 进入多选（移动端点网格/列表勾选框、桌面点表头复选框或 `Ctrl/Cmd+A`）→ `selected().size > 0` → 操作栏出现「全选」按钮。
- 点「全选」→ `selectAll()` → 所有 `filteredFiles` 被选中 → 文案切为「取消全选」。
- 点「取消全选」→ `clearSelection()` → `selected()` 为空集 → `Show when={store.selected().size > 0}` 变 false，整条操作栏隐藏（与原「取消」按钮行为一致）。
- 与桌面列表表头复选框（`FileViews.tsx:236-241`）语义一致：均对 `files`（即 `filteredFiles`）做全选/清空，不涉及子文件夹。

- [ ] **Step 5: 提交**

Run:
```bash
git add web/src/apps/dashboard.tsx
git commit -m "feat(web): 批量操作栏新增全选/取消全选按钮

原全选入口仅桌面列表表头复选框与 Ctrl/Cmd+A,网格视图与移动端
无法一键全选。在批量操作栏新增按钮,文案随是否全选切换,复用
store 已有 selectAll/clearSelection,覆盖所有视图与端。"
```

---

## 完成检查 (全部任务完成后执行一次)

- [ ] **Step 1: 跑一次完整 typecheck + build**

Run:
```bash
npm run typecheck && npm run build:web
```

Expected: 全部通过。

- [ ] **Step 2: 查看本次三个提交**

Run:
```bash
git log --oneline -3
```

Expected: 看到三个原子提交（Task 1/2/3 各一），均在 main 之上。

- [ ] **Step 3: 整体逻辑核对**

确认三项 spec 目标均落地：
- 移动端文件区可上下滑动（Task 1，高度链修复）。
- 移动端网格视图可勾选文件并进入多选（Task 2，勾选框移动端常显）。
- 「全选 / 取消全选」按钮在所有视图与端生效（Task 3，批量操作栏入口）。

桌面端既有交互（列表表头全选框、`Ctrl/Cmd+A`、`Esc`、hover 显示勾选框）未受影响。
