# Solid 2 兼容补丁

`@kobalte/core@2.0.0-alpha.2` 搭配 `solid-js` / `@solidjs/web@2.0.0-rc.13` 时需要这个补丁。`package.json` 的 `patchedDependencies` 和 `bun.lock` 固定补丁，`bun install --frozen-lockfile` 会自动应用。修改仅覆盖此版本的源码 JSX 和预编译 JS 两种入口。

## 浮层注册

DismissableLayer 原先在 `onSettled` 内读取 DOM ref。ref 的 signal 写入还未提交时，回调提前返回，导致浮层没有加入 layer stack：Escape 无法关闭、模态浮层外部指针阻断失效。

改成 `createEffect(ref, effect)`，在 ref 已提交后注册浮层，并在 effect cleanup 中用捕获的 DOM 元素移除浮层、恢复指针事件。保留上游处理嵌套浮层和事件的逻辑。

## 输入时机

TextField 初始化时对 value 的一次性受控模式判断使用 `untrack`；输入事件调用 onChange 后使用 `flush()` 提交写入，再将最终受控值写回原生 input，避免读取旧值重置输入。这是需要同步观察状态的原生 DOM 边界。

## 升级与移除

升级 Kobalte 后先核对这两处上游代码。修复已包含时移除 `patchedDependencies` 对应条目和 patch 文件，再更新锁文件。

运行 `bun run typecheck`、`bun run build` 和 `bun run test:ui`。测试覆盖连续输入、弹窗反复挂载/卸载、Escape/按钮/外部点击关闭、焦点归还、body 指针状态，以及菜单交互。此补丁不代表所有 Kobalte 组件均已验证兼容。
