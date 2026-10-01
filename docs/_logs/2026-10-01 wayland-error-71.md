# Wayland 协议错误 71 排查记录

- 日期：2026-10-01
- 项目：celestite（Tauri 2 + wry + GTK3 + WebKitGTK）
- 触发命令：`cargo tauri dev`
- 状态：已解决（环境变量 `__NV_DISABLE_EXPLICIT_SYNC=1`）
- 影响：应用在 Wayland 下启动即断连，窗口无法出现

---

## 1. 环境

| 项 | 值 |
|---|---|
| 发行版 | NixOS（`aorus-nixos`） |
| 会话 | Wayland（`XDG_SESSION_TYPE=wayland`，`WAYLAND_DISPLAY=wayland-1`，另有 Xwayland `:0`） |
| 合成器 | Hyprland 0.56.0+date=2026-09-29，由 GDM 会话启动 |
| GPU | NVIDIA GeForce RTX 4070 Ti SUPER，`/dev/dri/renderD128`（vendor `0x10de`，device `0x2705`） |
| 内核模块 | NVIDIA UNIX Open Kernel Module 595.104.02 |
| Mesa | 26.2.3（devShell 内） |
| GTK | 3.24.52 |
| WebKitGTK | 2.54.0（`webkitgtk_4_1`） |
| 工具链 | cargo 1.97.1（rust-bin nightly 2026-08-01）、bun 1.4.2、Vite 8.3.2、tauri-cli 2.11.4 |

显示器：DELL P2314H（scale 2）与 PHL 345M1CR（3440×1440@144，混合缩放）。与本次故障无关，仅记录。

---

## 2. 现象

`cargo tauri dev` 后 Rust 侧编译完成并启动 `target/debug/celestite`，随后立即打印：

```
Gdk-Message: 19:37:43.683: Trying wayland backend
Gdk-Message: 19:37:43.683: opening display
Gdk-Message: 19:37:43.697: seat 0x555556853240 with pointer, keyboard
Gdk-Message: 19:37:43.958: Error 71 (Protocol error) dispatching to Wayland display.
```

进程随即退出，窗口从未出现。从日志看，失败点在第 4 步——Wayland 连接建立、显示器与 seat 枚举都已完成，接着就断了。

系统日志的旁证：

```
Oct 01 19:37:43 gdm-wayland-session[3463]: error in client communication (pid 1146886)
```

---

## 3. 定位过程

### 3.1 排除会话/后端问题

`GDK_BACKEND` 未设置，应用已自动选择 Wayland 后端（见 `Trying wayland backend`），不存在后端选择错误。

### 3.2 确认错误性质

`Error 71` 是 `EPROTO`。GDK 在 `wl_display_dispatch()` 以该 errno 返回 -1 时打印这条消息，含义是**合成器向客户端发出了致命协议错误（`wl_display.error` 事件）**，连接已不可用。

也就是说：这不是 GDK 自身故障，而是**应用被判定违反 Wayland 协议**，被 Hyprland 主动断开。

### 3.3 拿到真正的错误

`Gdk-Message` 不含任何细节。用 `WAYLAND_DEBUG=1` 复跑，得到直接原因：

```
[11:39:27.103116] {Default Queue} -> wp_linux_drm_syncobj_manager_v1#41.get_surface(
                        new id wp_linux_drm_syncobj_surface_v1#38, wl_surface#34)
[11:39:27.103277] {Default Queue} -> wp_linux_drm_syncobj_manager_v1#41.import_timeline(
                        new id wp_linux_drm_syncobj_timeline_v1#53, fd 53)
[11:39:27.103279] {EGLSurface(34/...)} -> zwp_linux_dmabuf_v1#47.create_params(
                        new id zwp_linux_buffer_params_v1#54)
...
[11:39:27.106962] {Display Queue} wl_display#1.error(
                        wp_linux_drm_syncobj_surface_v1#38, 4, "Missing acquire timeline")
Gdk-Message: 19:39:27.106: Error 71 (Protocol error) dispatching to Wayland display.
```

---

## 4. 根因

问题出在渲染后端与 NVIDIA 驱动的交互，与应用代码无关。

事件链：

1. NVIDIA 的 EGL 驱动接入了 `wp_linux_drm_syncobj_manager_v1`（即 `linux-drm-syncobj-v1`，Wayland 显式同步协议）。NVIDIA 在 555.x 分支的 EGL 中引入对该协议的支持。
2. 它在客户端的 `wl_surface#34` 上创建了 `wp_linux_drm_syncobj_surface_v1`，并 `import_timeline` 导入一个 DRM syncobj timeline——**这等于声明该 surface 走显式同步**。
3. 随后经 DMABUF 通路 attach 缓冲并 commit，但**始终没有调用 `set_acquire_timeline` 设置 acquire timeline point**。
4. `linux-drm-syncobj-v1` 协议规定：若 surface 上存在 `wp_linux_drm_syncobj_surface_v1`，则每次 commit 只要 attach 了缓冲，就必须附带 pending 的 acquire timeline point；否则合成器必须报 `missing acquire timeline` 错误并断开连接。
5. Hyprland 遵从协议执行 fatal error，Wayland 连接被杀，窗口无法 map。

用队列名可以确认是谁在操作：出问题的请求来自 `{EGLSurface(34)}` 这条 Mesa/EGL 客户端队列，且该进程内同时出现了 `wl_registry#39`、`wl_registry#46` 等多个独立 registry——这正是驱动侧自己枚举全局对象的行为，而非上层图形栈。

**一句话**：NVIDIA EGL 驱动开启了 Wayland 显式同步，但提交路径漏设了 acquire timeline point，Hyprland 依协议断开连接。

---

## 5. 修复

### 5.1 主方案（已采用）

让 NVIDIA 驱动退回隐式同步（implicit sync），即不接入 `linux-drm-syncobj-v1`：

```bash
export __NV_DISABLE_EXPLICIT_SYNC=1
```

这是 NVIDIA 驱动自身的开关（其发行说明中即以此变量名提供给 EGL 应用控制显式同步）。

副作用：**DMABUF 呈现链路完整保留**，应用仍是硬件加速，只是同步方式从显式退回隐式。代价可忽略。

已写入 `flake.nix` 的 `shellHook`，`nix develop` / direnv 进入项目时自动生效：

```nix
shellHook = ''
  export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH" # Needed on Wayland to report the correct display scale
  export __NV_DISABLE_EXPLICIT_SYNC=1            # NVIDIA EGL 显式同步缺陷
'';
```

### 5.2 兜底方案

若某天驱动升级后仍复现，可让 WebKitGTK 完全放弃 DMABUF 渲染器，改走共享内存通路，彻底不产生 EGL 缓冲：

```bash
export WEBKIT_DISABLE_DMABUF_RENDERER=1
```

同样实测有效，但 Web 内容窗口合成走软件路径，**性能明显下降**，因此只作为兜底，未常驻。

---

## 6. 验证矩阵

| # | 环境变量 | 结果 |
|---|---|---|
| 1 | 无 | `Error 71`，窗口无法出现 |
| 2 | `__NV_DISABLE_EXPLICIT_SYNC=1` | 正常；`WAYLAND_DEBUG` 中仍可见 5 次 `zwp_linux_dmabuf_v1` 请求、`zwp_linux_buffer_params_v1.created` 正常产出缓冲，且驱动**不再绑定** `wp_linux_drm_syncobj_manager_v1`（仅在 global 通告阶段出现），DMABUF 通路保留 |
| 3 | `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 正常，WebKit 转软件渲染 |

最终确认：不带任何手动环境变量、仅经 `nix develop` 进入 shell 后执行 `cargo tauri dev`，全程 0 条协议错误，vite 正常监听 `127.0.0.1:1420`，`target/debug/celestite` 持续存活。

---

## 7. 遗留事项

1. **环境变量只覆盖 devShell。** `tauri build` 打出的安装包在 `nix develop` 之外运行时不受 `shellHook` 保护，同样的崩溃会复现。若需要，应在系统/用户级环境变量、或打包 wrapper 中同样注入。
2. **该缺陷属驱动侧**，需 NVIDIA 修复 EGL 显式同步的提交路径；此处只是绕开，不是根治。升级驱动后可尝试摘除该变量验证。

---

## 8. 附：可复跑的诊断命令

```bash
# 1. 复现并抓 Wayland 协议细节（关键：wl_display#N.error 一行）
cd /home/azurice/Files/celestite
WAYLAND_DEBUG=1 cargo tauri dev 2>&1 | tee /tmp/celestite-wl.log

# 2. 确认 GPU 与驱动
cat /proc/driver/nvidia/version
ls -l /dev/dri/renderD128

# 3. 修复后验证
nix develop --command bash -c 'echo "[$__NV_DISABLE_EXPLICIT_SYNC]"'
```

排查过程中落的原始日志：`/tmp/celestite-dev.log`、`/tmp/celestite-wl.log`、`/tmp/t1.log`、`/tmp/t2.log`、`/tmp/t4.log`（位于 `/tmp`，重启后丢失）。
