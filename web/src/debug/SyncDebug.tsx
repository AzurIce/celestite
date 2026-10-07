import { createSignal, For, Show, onCleanup } from "solid-js";
import { Button } from "../components/ui";
import { DebugSession } from "./session";
import { sameVersion } from "../lib/editor/view-changes";
import type { Version } from "../lib/editor/contract";
import "./debug.css";
function VersionView(props: { label: string; version?: Version | null }) {
  return (
    <details class="debug-version">
      <summary>{props.label}</summary>
      <pre>
        {props.version ? JSON.stringify(props.version, null, 2) : "仅驻留内存"}
      </pre>
    </details>
  );
}
export default function SyncDebug() {
  const session = new DebugSession();
  const [state, setState] = createSignal(session.snapshot());
  const [url, setUrl] = createSignal("");
  const [path, setPath] = createSignal("");
  const detach = session.subscribe(setState);
  onCleanup(() => {
    detach();
    session.dispose();
  });
  const converged = () => {
    const replicas = state().replicas;
    const version = replicas[0]?.document.core?.version;
    return (
      !!version &&
      replicas.length > 1 &&
      replicas.every(
        (replica) =>
          replica.online &&
          !replica.unconfirmed &&
          !replica.document.pending &&
          !!replica.document.core?.version &&
          sameVersion(replica.document.core.version, version),
      )
    );
  };
  return (
    <main class="sync-debug">
      <header class="debug-heading">
        <div>
          <p class="debug-eyebrow">CELESTITE / SYNC LAB</p>
          <h1>同步调试</h1>
          <p>
            每个实例运行生产编辑 Worker，通过 WebSocket
            实时同步。正文只在显式保存时写回文件。
          </p>
        </div>
        <a href={import.meta.env.BASE_URL}>返回编辑器</a>
      </header>
      <form
        class="debug-connect"
        onSubmit={(event) => {
          event.preventDefault();
          void session.connect(url());
        }}
      >
        <label>
          Vault URL
          <input
            aria-label="Vault URL"
            value={url()}
            onInput={(event) => setUrl(event.currentTarget.value)}
            disabled={state().connected || state().busy}
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={state().connected || state().busy}
        >
          连接 server
        </Button>
        <Button
          disabled={!state().connected || state().busy}
          onClick={() => void session.disconnect()}
        >
          结束会话
        </Button>
      </form>
      <Show when={state().error}>
        <p role="alert" class="debug-error">
          {state().error}
        </p>
      </Show>
      <Show when={state().connected}>
        <div class="debug-controls">
          <label>
            调试文档
            <select
              aria-label="调试文档"
              value={path()}
              onChange={(event) => setPath(event.currentTarget.value)}
              disabled={state().busy}
            >
              <option value="">选择文档</option>
              <For each={state().files}>
                {(file) => <option value={file.path}>{file.path}</option>}
              </For>
            </select>
          </label>
          <Button
            disabled={!path() || state().busy}
            onClick={() => void session.open(path())}
          >
            打开并重建实例
          </Button>
          <Button
            disabled={
              !state().path || state().busy || state().replicas.length >= 6
            }
            onClick={() => void session.addReplica()}
          >
            添加实例
          </Button>
        </div>
      </Show>
      <Show when={state().replicas.length}>
        <section class="debug-network" aria-label="同步网络">
          <span class="debug-node">HOST</span>
          <span class="debug-wire">↔ CRDT 增量 ↔</span>
          <For each={state().replicas}>
            {(replica) => <span class="debug-node">实例 {replica.name}</span>}
          </For>
          <strong role="status" aria-label="收敛状态">
            {converged() ? "因果版本已收敛" : "存在未同步版本"}
          </strong>
        </section>
        <div class="debug-panes">
          <For
            each={state().replicas}
            keyed={(replica) => replica.identity.instanceId}
          >
            {(replica) => (
              <section class="debug-pane" aria-label={`实例 ${replica().name}`}>
                <div class="debug-pane-heading">
                  <h2>实例 {replica().name}</h2>
                  <span>{replica().online ? "在线" : "连接中断"}</span>
                </div>
                <p class="debug-meta">
                  instance {replica().identity.instanceId}
                </p>
                <p class="debug-meta">
                  writer {replica().document.core?.writerId}
                </p>
                <textarea
                  aria-label={`实例 ${replica().name} 正文`}
                  value={replica().document.content}
                  readonly={
                    state().busy ||
                    !replica().online ||
                    !!replica().document.readOnlyReason ||
                    replica().document.locked
                  }
                  spellcheck={false}
                  onInput={(event) =>
                    session.edit(replica().name, event.currentTarget.value)
                  }
                />
                <div class="debug-actions">
                  <Button
                    size="sm"
                    disabled={
                      state().busy || !replica().document.core?.undo.canUndo
                    }
                    onClick={() => void session.undo(replica().name)}
                  >
                    撤销
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      state().busy || !replica().document.core?.undo.canRedo
                    }
                    onClick={() => void session.undo(replica().name, true)}
                  >
                    重做
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      state().busy || !replica().online || state().readOnly
                    }
                    onClick={() => void session.save(replica().name)}
                  >
                    保存到文件
                  </Button>
                  <Button
                    size="sm"
                    disabled={state().busy || replica().online}
                    onClick={() => void session.reconnect(replica().name)}
                  >
                    重新连接
                  </Button>
                </div>
                <p role="status" aria-label={`实例 ${replica().name} 同步状态`}>
                  {replica().document.pending
                    ? "输入正在提交到 core"
                    : replica().unconfirmed
                      ? "等待 host 确认"
                      : replica().online
                        ? "host 已确认"
                        : "连接中断，正文仍保留"}
                </p>
                <p role="status" aria-label={`实例 ${replica().name} 保存状态`}>
                  {replica().document.dirty
                    ? "正文尚未写回文件"
                    : "文件与正文一致"}
                </p>
                <Show when={replica().error || replica().document.error}>
                  <p role="alert" class="debug-error">
                    {replica().error || replica().document.error}
                  </p>
                </Show>
                <div class="debug-versions">
                  <VersionView
                    label="已接受正文版本"
                    version={replica().document.core?.version}
                  />
                  <VersionView
                    label="本机历史提交"
                    version={replica().document.core?.durableVersion}
                  />
                </div>
              </section>
            )}
          </For>
        </div>
      </Show>
    </main>
  );
}
