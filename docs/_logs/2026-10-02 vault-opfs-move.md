# Vault 的 OPFS 移动方案与两个项目的源码评估

- 日期：2026-10-02
- 项目：Celestite
- 范围：`hughfenghen/opfs-tools`、`componentor/fs`（`@componentor/fs`），以及 Vault 的移动语义
- 状态：完成源码评估及一个故障注入实验；移动实现与真实浏览器验证尚未完成
- 证据约定：外部引用全部固定到完整 commit SHA；本文记录这些版本的行为，不代表以后版本

## 1. 结论与需求边界

建议继续使用 Celestite 自己的小型 OPFS 后端，参考两个项目的复制、Worker 和并发设计，暂时不直接引入其中任何一个作为 Vault 的文件后端。

`opfs-tools` 接近我们需要的真实 OPFS 文件布局，但其移动、删除、覆盖和错误语义需要较多修正。`@componentor/fs` 提供的是更完整的浏览器 Node 文件系统兼容层；其快速 rename 主要来自自定义二进制 VFS，不能直接移植为真实 OPFS 目录的快速移动。其纯 OPFS 模式在本次快照中还存在递归复制失败后删除源目录的问题，已通过内存模拟故障注入复现。

封装 copy + delete 可以实现移动。需要承认目录移动是多步骤操作，并明确失败状态、额外空间、并发范围和重启恢复协议。仅有一个名为 `moveTo` 或 `rename` 的方法，并不意味着这些问题已经解决。

需求边界如下：

| 需求 | 本次采用的约定 |
|---|---|
| Native Vault | 绑定一个真实目录，业务路径相对该根目录 |
| Web Vault | 目前一个默认 Vault；OPFS 下固定为 `/vaults/default` |
| 运行时结构 | 保存 Vault 身份、后端、缓存、编辑状态；不把整库正文常驻内存 |
| 文件布局 | Web 中也优先采用实际目录和文件，正文与附件都可存在其中 |
| 写入 | 保存完整文件内容；已有文件提交前保留旧内容；不隐式创建父目录 |
| 移动 | 同一 Vault 内移动到一个明确的目标路径；目标已存在则失败 |
| 外部监听 | 接口保留 `watch`，OPFS 后端不发出任何事件 |
| 应用内变更 | 运行时在操作成功后更新缓存、发布业务事件，不依赖 `watch` |
| Native 接入 | 后端处理平台差异；上层不依赖 OPFS handle 或第三方 fs 类型 |

当前工作区已有 `VaultBackend`、路径和错误类型，以及基础 OPFS 后端。接口中的 `rename?` 目前只约定可选原生移动；OPFS 尚未实现它。本文后面的接口调整和恢复方案都是建议，不能视为已经落地。

## 2. 评估快照与方法

| 项目 | package.json 版本 | 完整 commit | commit 时间（UTC） | 许可证 |
|---|---|---|---|---|
| opfs-tools | 0.7.4 | `82d4fa11013cd795cf76a2e74be1fdf3a664cf43` | 2025-11-09 | MIT |
| @componentor/fs | 4.3.1 | `cff10495c962d7cca78ba7ba3f1cb3dc725ddb81` | 2026-08-27 | MIT |

版本和许可证依据固定快照的 [opfs-tools package.json][A1]、[LICENSE][A2]，以及 [componentor/fs package.json][B1]、[LICENSE][B2]。这里只核对仓库快照，没有独立核对 npm 发布包是否与之逐字一致，也不以 commit 日期推断维护质量。

评估读取了两者的路径解析、读写、移动和 Worker 实现，另检查了 componentor/fs 的协议派发、二进制 VFS、镜像队列、修复实现，以及相关测试和测试配置。文档用于了解作者意图，实际行为以调用链源码为准。

执行验证只包括第 4.4 节的实际源代码加内存 OPFS 模拟实验。没有安装两者作为 Celestite 依赖，没有执行其完整测试、真实性能基准或真实浏览器配额实验。此前当前环境启动本地服务及 Chromium 曾被沙箱以 `EPERM` 拒绝；因此也没有把 Celestite 的浏览器测试标记为通过。

## 3. opfs-tools：较薄的真实 OPFS 封装

### 3.1 接口、布局与适用范围

它主要提供文件、目录对象，以及读写、流、复制、移动和同步访问 handle 的异步包装。文件仍是实际 OPFS 文件，没有额外二进制文件系统。包清单未声明运行时 dependencies；核心实现相对集中。[A1][A3][A4][A5]

路径工具每次从 origin 的 OPFS 根开始解析；创建文件时，`create` 会传给中间目录。它没有与我们相同的“后端实例绑定 Vault 根、所有路径为受校验相对路径”的边界。公共删除根路径的逻辑会遍历删除整个 OPFS 根的子项，不能直接暴露给 Vault 调用方。[A3]

适配时至少需要重新建立根目录隔离、父目录创建规则、根保护、统一错误、关闭语义，以及应用内变更的处理方式。仅为路径增加前缀不足以完成这层适配。

### 3.2 moveTo 实际执行什么

文件和目录的 `moveTo` 都先调用 `copyTo`，再删除源。它没有使用原生 handle.move，也没有持久化移动日志。[A4][A5]

它的目标语义接近命令行的“复制进目录”，与我们指定最终路径的约定有区别：

| 调用情形 | 快照中的行为 |
|---|---|
| 目录目标不存在 | 按目标路径创建新目录 |
| 目录目标已经存在 | 创建或使用目标目录下的“源目录名”子目录 |
| 文件目标为文件对象 | 覆盖目标内容 |
| 文件目标为目录对象 | 在目标目录下按源文件名复制 |

因此，`moveTo(dir("b"))` 的实际目的地会受到 b 是否存在的影响。Vault 的移动应明确：`move("a", "b")` 就是得到 b，不能因目标状态变化而换成 b/a。

目录复制使用递归 `Promise.all`，没有总并发上限。复制失败时，目标可能部分存在，且其他已启动复制任务可能继续运行。不能在第一个 reject 后立即认定所有写入都已停止，然后开始清理目标。[A4]

### 3.3 失败语义与两个具体风险

**目录删除失败会被吞掉。** 目录 `remove` 对子项删除及自身删除的异常都只做 console.warn。`moveTo` 在复制成功后等待这个 remove，随后仍可返回成功，即使源目录还有残留。这不是推测作者意图：目录测试明确验证了“文件 reader 未关闭时，remove 返回，但目录中仍剩一个子项”的行为。[A4][A6]

**文件移动到自身会删除文件。** 文件 `copyTo` 遇到相同路径直接返回当前对象，而 `moveTo` 接着调用 `remove`。按这两段源码的组合，`file("a").moveTo(file("a"))` 不具备我们需要的安全 no-op 语义。这项是静态调用链发现，本次没有在浏览器运行该用例。[A5]

另外，复制没有通用回滚协议，删除失败没有结构化的“复制已完成、源删除未完成”状态，也没有跨标签页的整次移动锁。必须在我们自己的契约和实现中补上，不能把库返回成功直接当作移动完成。

### 3.4 写入、Worker 与生命周期

对 OTFile 的常规写入通过 Worker 中的同步访问 handle，先 truncate，再逐段写入。它适合随机位置访问，但不能直接满足我们已有的“replace 提交前保留旧文件”语义。复制到原生 FileSystemFileHandle 的分支则使用 stream.pipeTo(createWritable)，两条路径的写入行为应分开评估。[A5][A8]

Worker 包装最多创建三个 Worker，读写通过消息代理。写入 transfer 会转移传入 ArrayBuffer；错误回传只保留消息并重新构造普通 Error。直接适配会影响调用方 buffer 所有权，也会损失 QuotaExceeded、Busy 等分类信息。[A7]

本次读取的代理源码没有完整的 Worker 异常退出后 pending 请求收敛、超时和公共关闭协议。文件 handle 的排他访问也不等价于目录树移动的锁，无法单独协调“复制源、创建目标、删除源”这个整体操作。[A7][A8]

### 3.5 测试与接入判断

测试包含文件和目录移动的正常路径，以及打开 reader 后删除的行为。Vitest 浏览器配置选择 Chrome；包的 prepublishOnly 执行构建。它们能说明作者测试过什么，不能证明跨浏览器、配额耗尽或中途关闭页面后的恢复能力。[A1][A6][A9]

适合参考的部分：真实 OPFS 布局、文件流式复制、同步 handle 的 Worker 包装。

直接引入的收益有限：我们仍需维护一层严格适配，而且目录删除吞错、同路径移动、覆盖行为等还涉及内部逻辑。对当前小型后端，自己实现明确的移动协议更容易审查。

## 4. @componentor/fs：Node 兼容层与自定义 VFS

### 4.1 三种模式不是同一种存储方案

| 模式 | 权威内容 | 实际 OPFS 文件树 | rename 的主要工作 |
|---|---|---|---|
| vfs | `.vfs.bin` 中的 inode、路径和数据块 | 不为每个业务文件建立镜像 | 修改二进制 VFS 元数据 |
| hybrid，默认 | 二进制 VFS | 后台异步镜像 | 先改 VFS，再安排镜像更新 |
| opfs | 实际 OPFS 文件 | 就是实际存储 | 读取或复制内容，然后删除源 |

模式定义和默认值见 [B3][B4]。它不是一个只为 move 提供 polyfill 的工具：还实现同步 Node fs API、文件描述符、权限等兼容语义，以及 Worker、跨标签页通信和生命周期管理。

异步 promises API 有无 SAB 的消息通道路径，不能笼统地说整个库都必须部署 COOP/COEP。同步调用才依赖 SharedArrayBuffer 等条件；源码和文档还专门处理 WebKit 主线程同步调用的停滞问题。对我们的异步 Vault API，这些同步兼容能力并非当前需求。[B3][B4][B5]

### 4.2 VFS rename 为什么快，以及它没有保证什么

VFSEngine.rename 不复制文件正文的数据块，而是改写名称、路径及索引。目录移动仍需遍历路径索引，找出所有后代并逐个改写路径；不能把它描述为单次 parentId 更新，也不能给出“目录 rename 恒定时间”的保证。[B6]

它包含同路径、目录祖先关系和文件/目录类型冲突检查；同时允许替换已有目标。源码明确为 Vite 的目录提交场景允许替换非空目录，这一点偏离常见 Node/POSIX 的非空目录目标限制，也与 Celestite 的“不覆盖目标”需求不同。[B6][B11]

**元数据移动不等于崩溃原子移动。** rename 会写多个路径、inode 和索引相关结构；commitPending 分别写 bitmap 和 superblock，fsync 才另外调用 handle.flush。本次审阅的路径没有完整的 rename WAL 或事务提交协议，因此不能承诺在任意写入点中断后整棵树一定全旧或全新。[B6]

超级块 CRC 是损坏检测，不是整次目录 rename 的事务日志。相关测试验证 CRC 检测、旧格式挂载等能力；不能从这些测试推出所有路径记录和正文的原子一致性。[B12]

### 4.3 hybrid：返回成功与镜像完成是两回事

在实际源码中，sync-relay 执行 VFS 操作并给出响应，再安排向独立的 OPFS mirror Worker 发送消息。部分文件写入有 debounce，镜像 Worker 有顺序队列和重试。固定快照的模式文档有“镜像在同一个 relay”表述，与实际启动独立 Worker 的代码不一致；本评估采用源码调用链。[B3][B5][B8]

文件 rename 的镜像通常不是再移动源文件，而是从已完成 rename 的 VFS 读取目标内容，发送 write(target) + delete(source)。这样能处理临时文件尚未被镜像就已 rename 的情况。目录 rename 则发送目录移动消息，并把尚未执行的子文件同步任务重定向到新路径。[B7][B8]

镜像 Worker 的目录移动仍然需要递归复制，再删除源；相关 rename 异常可只记录警告。应用收到 VFS 成功响应，并不代表真实 OPFS 目录树已经完成移动。源与目标重复、镜像暂时缺内容，以及后台镜像最终失败，都是要单独处理的状态。[B8][B9]

promises.flush 派发 FSYNC 到引擎；本次审阅没有看到“等待镜像队列全部完成并回传确认”的屏障。不能把它当作确保两个存储副本一致的接口。[B4][B5][B6]

hybrid 还会保留二进制内容及实际文件镜像，通常增加内容存储和写入成本。这里没有给出精确倍数：块分配、稀疏文件、压缩和镜像状态都可能影响实际占用。对当前需求，引入双副本也增加了选择权威版本和修复冲突的责任。

### 4.4 纯 opfs 模式：已验证的错误传播问题

实际调用链为 promises.rename → 编码请求 → relay 的 OP.RENAME → OPFSEngine.rename。没有在外围派发层额外检查递归复制结果。[B4][B5][B10]

该引擎的单文件移动会：

1. 用 getFile().arrayBuffer() 读取整个源文件。
2. 写入目标，检查 write 返回的 status。
3. 成功后重试删除源；最终失败会返回错误。

目录分支会清理已有目标、创建新目录、递归复制，再删除源。递归函数等待了 mkdir 和 write，却没有检查它们返回的 status。write 内部捕获异常并返回错误 status，因此目标子文件写失败可以被递归函数忽略。[B10]

本次使用上述固定版本的实际 OPFSEngine 源码，加一个内存 OPFS handle 模拟器；在目标 `/dst/a.md` 的同步 write 中注入 QuotaExceededError，得到：

| 实验 | rename 返回 status | 源是否存在 | 目标内容 |
|---|---:|---|---|
| 目录 `/src` → `/dst`，子文件写入失败 | 0，成功 | 否 | a.md 为 0 字节 |
| 单文件 `/original.md` → `/dst/a.md`，相同写入失败 | 1，错误 | 是 | 源正文保留 |

两项均有断言并通过。第一项验证了“子文件写入失败 → 错误被忽略 → 删除源 → 报成功”的逻辑问题；第二项作为对照，验证单文件分支确实检查 status。write 还把该配额错误归为 ENOENT，损失了错误原因。[B10]

这是源代码逻辑的可重复模拟验证，**不是实际浏览器配额耗尽实验**；它不测浏览器何时抛错、锁释放时序或断电持久性。实验脚本存于本次会话的临时目录，不作为仓库测试资产。

静态检查还发现纯 opfs 的目录分支缺少 VFSEngine 中的祖先关系保护；移动到自己的后代有递归复制到新目标的风险。纯 opfs 分支也在查找源前就对同路径返回成功。这两项尚未执行实测。[B5][B6][B10]

纯 opfs 写入先 truncate 原文件，再写并 flush；目录复制按每个文件 arrayBuffer 全量读入。因此不能直接借用它来同时获得“旧正文提交前保留”和“大附件移动内存有界”这两个要求。镜像 Worker 的分块复制与这个引擎不是同一条执行路径。[B9][B10]

### 4.5 恢复、并发与资源成本

恢复能力确实比薄封装多，但应分别理解：

- hybrid 检测到 VFS 损坏后，会报告初始化错误并切换到 opfs；镜像可能落后于最后一次 VFS 成功操作。
- vfs 模式没有内容镜像，不能依赖上述降级路径。
- repair 扫描可恢复的二进制条目；load 可以从实际 OPFS 树重建 VFS。
- 修复先构建、验证临时二进制文件，再分块复制覆盖原文件。这不是原子交换，也不能替代每次 rename 的事务协议。[B4][B13]

跨标签页协调包括 Web Locks 的 leader 选举、转发，以及同步请求共享 SAB 的 ticket lock。它能解决比单文件 handle 锁更多的问题，不过协议互斥仍不等价于崩溃事务。接入时需要协调我们的关闭、取消和多实例语义。[B4][B14]

另一个值得保留的多 Vault 风险：实例注册键通过把 root 的所有非字母数字字符替换成下划线生成。`/a-b` 与 `/a_b` 会得到相同键，同一线程构造后一个实例时可返回已有实例。此处是静态表达式和分支检查，尚未运行完整构造器验证。[B4]

包把 Worker 脚本作为字符串嵌入，再通过 Blob URL 启动 Worker。需要在我们的构建、CSP 和 Tauri WebView 中验证；“无运行时 dependencies”不代表没有部署成本。该快照 Git tree 中 dist/index.js 为 524,088 字节，约 512 KiB，包含嵌入资源；这只是未压缩产物大小，不是 gzip、tree-shaking 后大小，也不是运行时内存测量。[B1][B15][B16]

生命周期实现提供 Worker 关闭和卸载处理，但构造器会启动 Worker 并尝试外部变化观察。若接入，我们仍必须让 Vault.watch 保持无事件语义，并评估是否有必要让内部观察机制参与我们的存储。[B4]

### 4.6 测试与接入判断

固定快照包含 Node fs 差分测试、固定 seed fuzz、镜像 rename 计划测试、CRC 测试，以及实际浏览器的目录镜像回归测试。浏览器回归通过轮询等待镜像最终收敛；这也直接体现“VFS 返回成功”和“镜像完成”的区别。[B11][B12][B17][B18]

Playwright 配置覆盖 Chromium、Firefox、WebKit 和可选 Edge；根 Vitest 配置另有 Chromium 浏览器执行配置。配置覆盖范围不等于本次已运行，也不等于所有测试在每种模式下都覆盖。[B19][B20]

这些测试是有价值的工程资产，不过尤其要区分 VFSEngine、镜像 planner 与纯 OPFSEngine 的覆盖。不能把二进制 VFS 的 rename 测试当作纯 OPFS 目录故障安全测试。

它更适合需要浏览器运行 Node 工具链、同步 fs、大量兼容 API 的项目。如果 Celestite 将来需要这些能力，可以重新评估；目前仅为了 Vault.move 引入整套系统，适配和数据格式维护成本偏高。

## 5. 面向 Celestite 的对比

| 维度 | opfs-tools | @componentor/fs | 自有小型 OPFS 后端 |
|---|---|---|---|
| 真实目录与文件为权威数据 | 是 | opfs 是；hybrid 权威在 VFS | 是 |
| 与当前相对路径接口匹配 | 需要适配根和路径语义 | 需要适配 Node 风格语义 | 已建立 |
| 默认不覆盖目标 | 不满足 | 不满足 | 可以明确实施 |
| replace 提交前保留旧正文 | OTFile 常规写入不满足 | opfs 写入不满足 | 当前使用 createWritable |
| 大附件移动内存有界 | 有流式复制路径 | 镜像分块；opfs 引擎全文件读取 | 可直接使用 File.stream |
| 目录移动崩溃原子性 | 未提供 | 本次源码不能证明 | 不承诺，另设计恢复 |
| 移动错误完整传播 | 目录删除吞错 | opfs 子文件写入错误丢失 | 需要作为验收要求 |
| 跨标签页整体协调 | 需自行补足 | 已有复杂协调协议 | 已有 Vault 写锁，需覆盖整次移动 |
| Node fs 兼容 | 不是主要目标 | 主要优势 | 当前不需要 |
| 主要借鉴点 | 流式复制、Worker IO | 元数据移动、队列、测试、生命周期 | 语义可以保持直接和可审查 |

这里没有以“超过十万文件”或“超过 50 MB”作为必须更换存储的门槛。文件数、平均大小、设备、遍历方式和写入频率都会改变结果；需要用 Celestite 的实际数据集测量。两种第三方实现也都没有消除 copy + delete 的额外磁盘空间需求。

## 6. 移动接口建议

### 6.1 接口表达业务语义

建议在准备实现时，把当前“可选原生 `rename?`”调整为明确的语义操作，例如：

```ts
move(from: VaultPath, to: VaultPath): Promise<void>;
```

move 表示同一后端绑定的 Vault 内移动，后端自行选择原生移动或复制删除。调用方不应根据浏览器是否有 handle.move 分支。尚未实现前，保留现状，不先声明必选方法而返回虚假的成功。

共同契约：

1. 校验路径和源条目；不允许移动 Vault 根。
2. 同路径只有在源存在时才是 no-op。
3. 目标必须不存在，目标父目录必须已存在；不自动创建父目录。
4. 目录不能移动到自身的后代。
5. 成功表示目标完整且源不存在；多步骤失败必须抛错，可能留下中间状态。
6. 目标内容复制完整前，不能开始删除源。
7. 不保证移动目录时其他读操作获得一致性快照；不承诺断电原子性。
8. 不要求复制删除保留 mtime；OPFS 无法统一设置这些元数据。
9. 跨 Vault 转移单独设计，不悄悄扩大此操作的范围。

Native 实现也遵守“不覆盖目标”的公共约定；不能直接假设平台 rename 默认行为就是该约定。平台接口与外部进程的竞争，应由 Native 后端单独处理。

### 6.2 原生移动与复制删除的选择

原生 handle.move 可以作为优化，但需要对实际条目做能力检测。固定版本的 MDN BCD 仍把 move 标为非标准轨道，并注明桌面 Chromium 的目录移动缺失；不能由“浏览器支持 OPFS”推导其完整支持文件与目录移动。[C1]

该数据快照的 Firefox、Safari 条目记录了支持，因此也不能继续笼统地把它们描述成“完全没有 move”。实际方法暴露、重载、文件与目录差异及错误行为，仍要通过我们的目标浏览器测试确认。本文不把兼容数据当作成功执行证明。

只有在确认未发生修改且能力确实不支持时才进入 fallback。配额、权限、锁占用、目标冲突和未知 IO 错误应直接报告；不能统一 catch 后改走复制删除。

原生移动同样需要 Vault 写锁、源/目标预检及“不覆盖”的保证。预检只协调遵守同一锁协议的 Celestite 实例，不会约束 DevTools 或其他直接访问 OPFS 的代码。无法验证原生移动满足我们语义时，可以先统一使用 fallback。

### 6.3 fallback 的执行范围

整次操作在当前 `celestite.vault.opfs:<id>` 写锁内完成。公开 move 获取一次锁，再调用不重复取锁的内部复制和删除函数；不要用公开 read/write/remove 拼接出分段加锁的操作，也不要在已持锁时嵌套获取同一把非重入锁。

文件复制使用 File.stream 和 createWritable，不借助 readFile 将大附件完整读入 Uint8Array。逐个文件复制，或使用有上限的并发；所有任务结束后才允许清理。流复制异常应 abort；abort 或清理失败也需要保留并报告。

目录逐层复制实际子项，包括空目录。每个目标文件 stream.close 成功以后，才把它记为复制完成。全部完成后，才删除源树。复制阶段需要同时容纳源和目标，因此可能因额外空间不足而失败。

最低内存开销可以与流缓冲和受限并发相关，但复制时间仍与总字节数、文件数量有关。大目录移动也会长期占用写锁；以后需要进度或取消时可以扩展接口。取消只能请求停止，并不表示已经撤销之前的写入。

### 6.4 错误必须携带操作阶段

现有 VaultError 中只有普通 IO 等错误码，尚不能充分表达移动部分完成。建议实现时增加结构化移动错误，至少携带：

- operationId、from、to、阶段和底层 cause；
- 目标是否已完整复制；
- 是否已经开始删除源；
- 清理是否失败。

复制失败、尚未删除源时，可以清理本次创建的目标；清理失败则报告残留。源删除已经开始后，源树可能部分缺失，此时必须保留完整目标，不能用“回滚目标”掩盖错误。

目录 remove 本身也可能部分完成，禁止以“不抛错”替代成功判据。若删除源失败，应向运行时提供可恢复状态，而不是发布普通移动成功事件。

## 7. 从内存错误处理到重启恢复

try/catch 只能处理进程仍在运行时的失败。要让页面关闭或进程崩溃后可恢复，还需要持久化操作记录。这是额外工作，两个项目都不能直接给我们的真实文件树提供该移动协议。

建议在业务 Vault 之外建立私有目录，例如 `/celestite-internal/moves/<vault-id>/<operation-id>`，存版本化 journal 和复制清单。这样内部文件不会被 readDir、搜索或导出误认为用户内容。命名只是方案示例，尚未落地。

最小状态机：

```text
prepared -> copying -> copied -> deleting-source -> done
```

| 状态 | 记录含义 | 重启处理方向 |
|---|---|---|
| prepared / copying | 源应尚未删除，目标可能不完整 | 核验源和操作所属目标；续拷或清理本次目标 |
| copied | 目标清单已复制并验证，源删除尚未开始 | 重新核验后继续 |
| deleting-source | 源可能部分删除 | 优先保留完整目标，继续删除符合清单的源 |
| done | 移动已完成，仅剩记录清理 | 核验后清理 journal |

实现恢复时必须注意：

1. 在取得同一 Vault 写锁后恢复；打开 Vault 完成恢复以前，不接受新的相关写操作。其他已经打开的实例也应在写操作入口识别未完成记录。
2. journal 需要操作 ID、格式版本、源/目标、条目清单、复制完成标记和足够的版本校验信息。文件大小和 mtime 不能单独证明内容相同；必要时使用内容摘要，并验证目录清单。
3. 删除源以前提交并核验“copied”记录。遇到记录丢失、不完整或与文件状态矛盾时，保留数据并报告恢复冲突。
4. 不能只按旧路径删除。旧路径可能已经被重新创建或修改；发现额外条目、内容变化或无法确认身份时，停止破坏性恢复。
5. Web Locks 仅协调参与协议的代码。对不可控的外部修改不能承诺无条件自动恢复，冲突时需要可见的处理路径。
6. 日志写入也可能耗尽配额。无法记录进入删除阶段所需的状态时，不删除源。
7. journal 是可恢复协议，不是浏览器提供的多文件事务；不能仅凭 Promise 完成宣称获得断电持久性或磁盘写入顺序保证。

可先实现严格传播错误的 copy + delete，满足最基本的不吞错、不覆盖和复制前不删除。若要把它作为日常可靠的目录移动功能交付，建议将重启恢复和故障注入一起完成，不能把可恢复性留给没有定义的“以后”。

在没有通用目录原生移动的情况下，目标目录会在复制过程中逐步可见。若产品要求原子可见的目录切换，就需要额外的逻辑命名空间或事务元数据；单纯增加 staging 目录再复制到最终路径，并不会消除最后发布阶段的多步骤问题。

## 8. 验收与后续决策

移动实现至少验证以下场景：

| 类别 | 关键用例与判据 |
|---|---|
| 正常移动 | 文件、嵌套目录、空目录、Unicode 名称、大附件；成功后源消失且目标逐项一致 |
| 路径保护 | 同路径、缺失源、根目录、自身后代、缺失父目录、已有目标；失败不破坏原有内容 |
| 复制故障 | 在读取、写入、close、journal 提交处注入错误；未开始删除源，错误向调用方传播 |
| 删除故障 | 在删除若干源子项后失败；完整目标保留，不能报告成功 |
| 清理故障 | abort 或删除残留失败；保留阶段、底层错误和恢复记录 |
| 重启 | 各阶段中断并重新打开；恢复幂等，不删除后来修改或新建的内容 |
| 并发 | 两标签页的 move/write/remove；锁内预检；避免嵌套锁死锁 |
| 资源释放 | 移动期间 close、Worker 或页面结束；公开 Promise 与 handle 生命周期可收敛 |
| 后端语义 | OPFS.watch 始终不发事件；业务缓存能处理成功及部分失败 |
| 浏览器 | Chromium、Firefox、WebKit，以及 Native 后端独立测试；不只测模拟器 |

性能评估使用真实目标设备和可公开复现的数据集，分别测文件数、目录深度、附件大小、内存峰值、空间峰值及锁等待；不要套用第三方文档的 files/s 数字。

若以后需要大量 Node fs 兼容能力，再评估 @componentor/fs；若需要高频大目录逻辑改名、而实际 OPFS 文件布局不是必要条件，再评估二进制 VFS、数据库或以稳定 ID 为键的命名空间。稳定 ID 可以与路径并存，路径也不必被固化为所有层的身份；这属于新数据模型决策，迁移仍需版本、校验和恢复。

当前决策是：保留小型真实文件后端，先定义可审查的 move 契约，再实现原生能力优化或流式 copy + delete，并为部分失败和重启恢复建立显式协议。

## 9. 固定证据索引

以下引用均固定到本次评估的完整 commit。没有引用可变分支页面、在线 API 文档或 issue 状态；相关问题是否已经在后续版本修复，不属于本文结论。

[A1]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/package.json
[A2]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/LICENSE
[A3]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/common.ts#L28-L89
[A4]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/directory.ts#L87-L169
[A5]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/file.ts#L49-L337
[A6]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/__tests__/directory.test.ts#L32-L77
[A7]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/access-worker.ts#L15-L118
[A8]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/src/opfs-worker.ts
[A9]: https://github.com/hughfenghen/opfs-tools/blob/82d4fa11013cd795cf76a2e74be1fdf3a664cf43/vite.config.ts
[B1]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/package.json
[B2]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/LICENSE
[B3]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/docs/filesystem-modes.md
[B4]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/filesystem.ts
[B5]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/sync-relay.worker.ts
[B6]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/vfs/engine.ts
[B7]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/opfs-sync-plan.ts#L28-L101
[B8]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/sync-relay.worker.ts#L1576-L1670
[B9]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/opfs-sync.worker.ts#L155-L497
[B10]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/opfs-engine.ts#L224-L498
[B11]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/tests/opfs-sync-rename.test.ts
[B12]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/tests/superblock-crc.test.ts
[B13]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/repair.worker.ts
[B14]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/protocol/fs-lock.ts
[B15]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/src/workers/worker-blob.ts#L23-L59
[B16]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/dist/index.js
[B17]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/src/tests/fuzz-parity.test.ts
[B18]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/tests/benchmark/opfs-mirror-rename.spec.ts
[B19]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/playwright.config.ts
[B20]: https://github.com/componentor/fs/blob/cff10495c962d7cca78ba7ba3f1cb3dc725ddb81/vitest.config.ts
[C1]: https://github.com/mdn/browser-compat-data/blob/852a2f6fa49037e644a4554c38fc720d5b1bd24d/api/FileSystemHandle.json
