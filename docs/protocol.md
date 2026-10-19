# 远端协议 v5

`PROTOCOL_VERSION = 5`。HTTP 与 WebSocket 共用同一版本号；server 只接受 v5 客户端。

## 入口

远端以 `https://host/<key>` 为基址，接口追加 `/api/v5/...`，WebSocket 为 `/<key>/api/v5/sync`。

`GET /<key>/api/v5` 返回：

```json
{
  "protocol": "celestite-vault",
  "protocolVersion": 5,
  "shareId": "...",
  "name": "...",
  "readOnly": false,
  "previewResourceRoot": "...",
  "vault": { "vaultId": "...", "historyId": "..." },
  "capabilities": {
    "watch": true,
    "conditionalWrite": true,
    "documentEditing": true,
    "documentEvents": true,
    "websocketSync": true,
    "vaultCrdt": false
  }
}
```

HTTP 与 SSE 使用 `Authorization` 之外的分享 key 路径凭证，规则与文件接口相同。所有响应禁止缓存。

## 握手

客户端第一帧：

```json
{
  "protocolVersion": 5,
  "vault": { "vaultId": "...", "historyId": "..." }
}
```

server 依次返回 `hello`、`ready`、`members`：

```json
{
  "kind": "hello",
  "sessionId": "...",
  "vault": { "vaultId": "...", "historyId": "..." }
}
```

版本不符时返回 `{"kind":"fatal","code":"Unsupported","message":"Protocol version 5 required"}` 并关闭连接；Vault 或历史身份不符时返回 `Conflict`。

## 文档读取模型

```json
{
  "id": "...",
  "path": "notes/a.md",
  "version": {
    "identity": { "document_id": "...", "history_id": "..." },
    "clocks": { "1": 4 }
  },
  "savedVersion": null,
  "fileRevision": "...",
  "dirty": false,
  "deleted": false,
  "conflict": false,
  "error": null,
  "externalChange": null,
  "recoveryError": null,
  "snapshot": { "text": "...", "stateRevision": 3 },
  "undo": { "canUndo": true, "canRedo": false },
  "peerId": "123",
  "savedContent": "...",
  "bom": false,
  "lineEnding": "\n",
  "autosaveDelay": 800
}
```

- 顶层只有一个 `version`；`snapshot` 只有 `text` 与 `stateRevision`。
- `peerId` 是十进制 u64 字符串。CRDT 历史驻留内存；host 确认不表示普通文件已保存。
- `recoveryError` 表示本地明文恢复 checkpoint 的错误，不阻止继续编辑；无恢复区的远端副本和 host 为 null。
- `fileRevision` 标识磁盘字节基线；`stateRevision` 是 Buffer 本地状态计数。
- `savedContent` 仅在打开或磁盘基线变化时发送。

## WebSocket 帧

客户端请求：`{ sessionId, requestId, method, ...参数 }`。

| method              | 参数                                     | 结果          |
| ------------------- | ---------------------------------------- | ------------- |
| `open`              | `path` 或 `id`                           | `document` 帧 |
| `updates`           | `id, packet, version, operation`         | 幂等确认      |
| `save`              | `id, version`                            | `document` 帧 |
| `probe`             | `id, version`                            | 因果检查点    |
| `retry_observation` | `id`                                     | `document` 帧 |
| `unsubscribe`       | `id`                                     | 释放正文订阅  |
| `set_view`          | `viewId, documentId, focused, selection` | 在线成员视图  |
| `ping`              | —                                        | 心跳响应      |

server 帧：

- `reply { requestId, result }` / `reply { requestId, error }`
- `document { sequence, document, packet, peerId }`
- `members { state }`
- `tree`
- `heartbeat`

`document` 的 `document` 形状与读取模型一致，不含正文快照；正文来自 `packet`。`peerId` 为本会话分配的 writer，不是 Member 或 User。

## HTTP

| 方法   | 路径                       | 用途                       |
| ------ | -------------------------- | -------------------------- |
| GET    | `/stat?path=`              | 条目元数据                 |
| GET    | `/directory?path=`         | 目录子项                   |
| GET    | `/file?path=`              | 读取普通文件，带 ETag      |
| PUT    | `/file?path=&mode=`        | 条件写入，`If-Match`       |
| POST   | `/directory?path=`         | 创建目录                   |
| DELETE | `/entry?path=&recursive=`  | 删除                       |
| POST   | `/rename`                  | `{ from, to }`             |
| GET    | `/events`                  | 文件树变化 SSE             |
| GET    | `/documents`               | 已加载文档列表             |
| POST   | `/documents/open`          | `{ path }`，打开并返回文档 |
| GET    | `/documents/<id>`          | 文档元数据                 |
| GET    | `/documents/<id>/snapshot` | 完整 `HistoryPacket`       |
| POST   | `/documents/<id>/updates`  | 起始 `Version`，返回增量   |
| GET    | `/documents/events`        | 文档元数据 SSE             |
| POST   | `/preview/resources`       | 只读 package 资源          |
| POST   | `/preview/directory`       | 只读 package 目录          |

路径相对于 `/<key>/api/v5`。错误体为 `{ code, message, path }`；`code` 为 `ErrorCode` 字符串。

## 文档事件

SSE `event: documents`：

```json
{
  "kind": "resync",
  "streamId": "...",
  "sequence": 3,
  "vault": { "vaultId": "...", "historyId": "..." },
  "documents": [
    {
      "id": "...",
      "path": "a.md",
      "version": { "...": "..." },
      "savedVersion": null,
      "fileRevision": "...",
      "dirty": false,
      "deleted": false,
      "conflict": false,
      "error": null,
      "externalChange": null,
      "recoveryError": null,
      "available": true
    }
  ]
}
```

连接首先收到 `resync` 全量快照，之后收到 `changed`。`Last-Event-ID` 不表示持久化回执；落后时重新取得全量状态。

## 兼容边界

- v5 不兼容 v4 及更早客户端，不提供旧 API 路由或字段转换。
- 删除本机 CRDT 持久化状态及 mutation 中的历史提交回执；文档状态使用 `recoveryError`。
- 本地明文恢复格式独立于 wire。旧私有数据仅一次性迁移明文与恢复证据，重启建立新的 CRDT 历史身份。
- 旧 server 与新 Web、旧 Web 与新 server 均不支持；客户端需刷新到同版本。
