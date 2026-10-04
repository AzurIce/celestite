# Filesystem / CRDT bridge spike

独立可执行规格，固定 Loro **1.16.2**。不加入生产 workspace，不修改正在开发的 editor / preview / server 代码。

```sh
CARGO_TARGET_DIR=/home/azurice/Files/.celestite-headless-target \
  cargo test --manifest-path spikes/filesystem-crdt/Cargo.toml -- --nocapture

cargo clippy --manifest-path spikes/filesystem-crdt/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path spikes/filesystem-crdt/Cargo.toml --check
```

`src/lib.rs` 在单文件、单 owner、串行处理的条件下实现：

- 完整 Loro 历史、可恢复的磁盘分支 frontiers、原始字节、格式与内容哈希。
- 从磁盘分支 `fork_at`，使用 scalar Myers diff 更新独立 writer，然后合入当前 core。
- 更新包对应的历史与新磁盘 cursor 在同一次 redb 事务中提交，提交后才发布状态；乱序依赖包持久化并去重。
- 格式变化不生成文本操作；Unicode / 空正文正常参与历史。
- Prepared / Started 写回意图与磁盘回执；不确定的写回停止自动协调。

实验使用完整 checkpoint 提交，恢复会重建 LoroDoc，不维持 UI 订阅、undo 会话或现有 core 的事件模型；生产实现应追加 journal、保存 cursor，并在成功提交后应用同一份操作。固定 writer ID 仅用于可复现测试，依赖独占数据库和顺序执行，不能用于真实网络。

`tests/bridge.rs` 包含 **24 项测试**：连续磁盘分支、三副本乱序 / 重放、个人撤销、外部覆盖、观察事务与写回崩溃点、真实 notify / 原子保存、编码变化、无效输入、2,197 组小型 Unicode 历史以及 24 × 100 步交错操作。另有故意复现限制的反例：单区间 diff、未观察的中间状态、哈希检查与 rename 的竞争、原地写入的半成品、崩溃后的旧字节 ABA、Linux exchange 后的旧 FD 写入。

这里的崩溃测试是应用级故障注入和重开真实 redb 数据库，**不是断电测试**。`save_file` 仅验证安静 / 合作文件系统上的状态机，使用检查后替换，**没有原子 CAS**。Linux exchange 测试验证保留 displaced bytes 的价值，不提供其完整 WAL、恢复或目录协调实现。

完整结论和生产实现方案记录在 `docs/_logs/2026-10-04 filesystem-crdt-bridge.md`。
