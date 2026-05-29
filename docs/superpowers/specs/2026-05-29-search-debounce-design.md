# 搜索防抖设计

日期：2026-05-29
范围：仅前端（`web/`），不涉及后端与数据库。

## 背景与问题

仪表盘文件列表通过 `createResource` 按 `{ folder, search }` 加载（`web/src/features/dashboard/store.ts`）。搜索框的 `onInput` 每敲一个字符就调用 `setSearch`，立即驱动 `fileQuery` 变化并触发一次后端请求：

```js
// web/src/apps/dashboard.tsx:491
onInput={(e) => {
  const v = e.currentTarget.value;
  setTimeout(() => store.setSearch(v), 0);
}}
```

输入「report」会连续发出 6 次 `/api/files?search=...` 请求，造成请求风暴与可感知的搜索延迟。

## 目标

- 连续输入时只在停止输入约 250ms 后发出 **1 次** 后端搜索请求。
- 输入框本身即时响应（输入框值、`currentSubfolders` 的客户端即时过滤保持零延迟）。
- 清空搜索或切换文件夹时立即生效，不被防抖延迟。

## 非目标（YAGNI）

- 不引入 `limit` / 分页 / 无限滚动。
- 不改加载态渲染（白屏闪烁问题本次不处理）。
- 不改后端、不改客户端排序/过滤逻辑。
- 不引入第三方防抖库（`@solid-primitives/scheduled` 等），用极小的自写防抖即可。

## 设计

防抖下沉到 `store.ts`，使输入即时、请求防抖：

- 保留即时 `search` signal —— 输入框值与 `currentSubfolders` 客户端过滤继续使用它，零延迟。
- 新增内部 `debouncedSearch` signal（默认 250ms）—— **仅它驱动 `fileQuery`**（即后端请求）。
- `setSearch(q)`：
  - 同步 `setSearchInternal(q)`（输入框即时更新）；
  - 若 `q === ''`：清除计时器并**立即**同步 `setDebouncedSearch('')`（覆盖清空搜索、`setCurrentFolder` 内的清空）；
  - 否则：清除上一个计时器，`setTimeout(() => setDebouncedSearch(q), 250)`。

### 关键代码变更（示意）

`web/src/features/dashboard/store.ts`：

```ts
const [search, setSearchInternal] = createSignal('');
const [debouncedSearch, setDebouncedSearch] = createSignal('');
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const setSearch = (q: string) => {
  setSearchInternal(q);
  clearTimeout(searchTimer);
  if (q === '') {
    setDebouncedSearch('');           // 清空/切换立即生效，不延迟
    return;
  }
  searchTimer = setTimeout(() => setDebouncedSearch(q), 250);
};

// fileQuery 改用 debouncedSearch 驱动后端请求；search() 仍用于即时 UI
const fileQuery = createMemo(() => ({ folder: currentFolder(), search: debouncedSearch() }));
```

`web/src/apps/dashboard.tsx`（搜索框 `onInput`）：

```jsx
onInput={(e) => store.setSearch(e.currentTarget.value)}
```

（去掉原 `setTimeout(0)` hack，防抖已在 store 内统一处理。）

### 数据流

- 输入字符 → `setSearch` → `search` 即时更新（输入框、子文件夹过滤即时刷新）。
- 停止输入 250ms → `debouncedSearch` 更新 → `fileQuery` 变化 → 触发 1 次后端请求。
- 清空 / `setCurrentFolder('...')` 内 `setSearch('')` → `debouncedSearch` 立即清空 → 立即请求。

## 边界与一致性

- `setCurrentFolder` 在 `batch` 内调用 `setSearch('')`，因 `q === ''` 走立即分支，切换文件夹时不会残留旧搜索词、无 250ms 延迟。
- `currentSubfolders` 继续依赖即时 `search()`，子文件夹过滤手感不变。
- 防抖时长 250ms 为默认值，集中在一处常量，后续可调。

## 验证（§13 非真机）

- `npm run typecheck`（`tsc` 后端 + `web/tsconfig.json` 前端）通过。
- `npm run build:web`（vite 构建）通过，确认编译无误。
- 以逻辑推理确认：连续输入仅触发 1 次请求、清空/切换立即生效、输入框即时响应。
- 不在真实浏览器/设备上运行验证。
