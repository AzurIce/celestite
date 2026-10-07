import { createSignal, For, Show, onCleanup } from "solid-js";
import { Button } from "../components/ui";
import {
  DebugSession,
  hasUnsent,
  sameVersion,
  type DebugDocument,
} from "./session";
import type { Version } from "../lib/editor/contract";
import "./debug.css";

function VersionView(props: {
  label: string;
  version: Version | null;
  empty?: string;
}) {
  return (
    <details class="debug-version">
      <summary>
        {props.label}{" "}
        <span>
          {props.version
            ? `${Object.keys(props.version.clocks).length} writers`
            : (props.empty ?? "未确认")}
        </span>
      </summary>
      <pre>
        {props.version
          ? JSON.stringify(props.version, null, 2)
          : (props.empty ?? "无持久化确认")}
      </pre>
    </details>
  );
}
function StateView(props: {
  document: DebugDocument;
  privateReplica?: boolean;
}) {
  return (
    <div class="debug-versions">
      <VersionView label="正文版本" version={props.document.snapshot.version} />
      <VersionView
        label="本机历史提交"
        empty="仅驻留内存"
        version={props.document.durableVersion}
      />
      <VersionView
        label="普通文件写回"
        empty={props.privateReplica ? "无普通目录" : "未确认"}
        version={props.document.savedVersion}
      />
    </div>
  );
}
export default function SyncDebug() {
  const session = new DebugSession();
  const [state, setState] = createSignal(session.snapshot());
  const [url, setUrl] = createSignal("");
  const [path, setPath] = createSignal("");
  const unsubscribe = session.subscribe(setState);
  onCleanup(() => {
    unsubscribe();
    session.dispose();
  });
  const working = () =>
    state().busy || state().replicas.some((replica) => replica.edits > 0);
  const converged = () =>
    !!state().host &&
    state().replicas.length > 0 &&
    state().replicas.every(
      (replica) =>
        !replica.edits &&
        !replica.lastError &&
        sameVersion(
          replica.document.snapshot.version,
          state().host!.snapshot.version,
        ),
    );
  return (
    <main class="sync-debug">
      <header class="debug-heading">
        <div>
          <p class="debug-eyebrow">CELESTITE / SYNC LAB</p>
          <h1>同步调试</h1>
          <p>
            多个独立 core 通过 host 交换真实 CRDT
            更新。调试实例只保留在本次页面内存中。
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
          disabled={!state().connected || working()}
          onClick={() => {
            session.disconnect();
          }}
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
              disabled={working()}
            >
              <option value="">选择文档</option>
              <For each={state().files}>
                {(file) => <option value={file.path}>{file.path}</option>}
              </For>
            </select>
          </label>
          <Button
            disabled={!path() || working()}
            onClick={() => void session.open(path())}
          >
            打开并重建实例
          </Button>
          <Button
            disabled={
              !state().host || working() || state().replicas.length >= 6
            }
            onClick={() => void session.addReplica()}
          >
            添加实例
          </Button>
          <Button
            variant="primary"
            disabled={!state().host || working()}
            onClick={() => void session.syncAll()}
          >
            同步全部
          </Button>
          <label class="debug-check">
            <input
              type="checkbox"
              checked={state().automatic}
              disabled={!state().host || working()}
              onChange={(event) =>
                session.setAutomatic(event.currentTarget.checked)
              }
            />
            每秒同步
          </label>
        </div>
        <Show when={state().files.length === 0}>
          <p class="debug-empty">这个 Vault 中没有文件。</p>
        </Show>
      </Show>
      <Show when={state().host}>
        {(_host) => (
          <>
            <section class="debug-network" aria-label="同步网络">
              <span class="debug-node">HOST</span>
              <span class="debug-wire">↔ CRDT 增量 ↔</span>
              <For
                each={state().replicas}
                keyed={(replica) => replica.identity.instanceId}
              >
                {(replica) => (
                  <span class="debug-node" data-paused={replica().paused}>
                    实例 {replica().name}
                    {replica().paused ? " · 暂停传输" : ""}
                  </span>
                )}
              </For>
              <strong role="status" aria-label="收敛状态">
                {converged() ? "因果版本已收敛" : "存在未同步版本"}
              </strong>
            </section>
            <div class="debug-panes">
              <section class="debug-pane debug-host" aria-label="Host">
                <div class="debug-pane-heading">
                  <h2>Host</h2>
                  <span>{state().readOnly ? "只读" : "可写"}</span>
                </div>
                <p class="debug-meta">{state().host!.path}</p>
                <p class="debug-meta">
                  doc {state().host!.id} · writer {state().host!.writerId}
                </p>
                <textarea
                  aria-label="Host 正文"
                  value={state().host!.snapshot.text}
                  readonly
                  spellcheck={false}
                />
                <div class="debug-actions">
                  <Button
                    size="sm"
                    disabled={working()}
                    onClick={() => void session.refresh()}
                  >
                    刷新 host
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      working() || state().readOnly || state().host!.deleted
                    }
                    onClick={() => void session.save()}
                  >
                    保存到文件
                  </Button>
                </div>
                <p role="status" aria-label="Host 保存状态">
                  {state().host!.conflict
                    ? "外部文件冲突"
                    : state().host!.dirty
                      ? "正文尚未写回文件"
                      : "文件与正文一致"}
                </p>
                <Show when={state().host!.persistenceError}>
                  <p class="debug-error">{state().host!.persistenceError}</p>
                </Show>
                <StateView document={state().host!} />
                <details>
                  <summary>普通文件基线</summary>
                  <pre class="debug-baseline">{state().host!.savedContent}</pre>
                </details>
              </section>
              <For
                each={state().replicas}
                keyed={(replica) => replica.identity.instanceId}
              >
                {(replica) => (
                  <section
                    class="debug-pane"
                    aria-label={`实例 ${replica().name}`}
                  >
                    <div class="debug-pane-heading">
                      <h2>实例 {replica().name}</h2>
                      <span>{replica().paused ? "传输暂停" : "传输就绪"}</span>
                    </div>
                    <p class="debug-meta">
                      instance {replica().identity.instanceId}
                    </p>
                    <p class="debug-meta">
                      writer {replica().document.writerId} · 私有内存历史
                    </p>
                    <textarea
                      aria-label={`实例 ${replica().name} 正文`}
                      value={replica().text}
                      readonly={
                        state().busy ||
                        state().readOnly ||
                        replica().document.deleted
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
                          working() || replica().paused || state().readOnly
                        }
                        onClick={() => void session.push(replica().name)}
                      >
                        推送
                      </Button>
                      <Button
                        size="sm"
                        disabled={working() || replica().paused}
                        onClick={() => void session.pull(replica().name)}
                      >
                        拉取
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          working() ||
                          state().readOnly ||
                          !replica().document.undo.canUndo
                        }
                        onClick={() => void session.undo(replica().name)}
                      >
                        撤销
                      </Button>
                      <Button
                        size="sm"
                        disabled={
                          working() ||
                          state().readOnly ||
                          !replica().document.undo.canRedo
                        }
                        onClick={() => void session.undo(replica().name, true)}
                      >
                        重做
                      </Button>
                      <Button
                        size="sm"
                        disabled={working()}
                        onClick={() => session.pause(replica().name)}
                      >
                        {replica().paused ? "恢复传输" : "暂停传输"}
                      </Button>
                    </div>
                    <p
                      role="status"
                      aria-label={`实例 ${replica().name} 同步状态`}
                    >
                      {replica().edits
                        ? "输入正在提交到 core"
                        : hasUnsent(
                              replica().document.snapshot.version,
                              state().host!.snapshot.version,
                            )
                          ? "有操作尚未推送"
                          : sameVersion(
                                replica().document.snapshot.version,
                                state().host!.snapshot.version,
                              )
                            ? "与 host 一致"
                            : "需拉取 host 更新"}
                    </p>
                    <Show when={replica().lastError}>
                      <p role="alert" class="debug-error">
                        {replica().lastError}
                      </p>
                    </Show>
                    <StateView document={replica().document} privateReplica />
                    <VersionView
                      label="host 历史提交回执"
                      version={replica().acknowledged}
                    />
                  </section>
                )}
              </For>
            </div>
          </>
        )}
      </Show>
      <section class="debug-log" aria-label="同步日志">
        <div class="debug-pane-heading">
          <h2>传输日志</h2>
          <span>最近 100 条 · 正文不会自动写回文件</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>实例</th>
              <th>操作</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <For each={state().log}>
              {(entry) => (
                <tr data-failed={entry.failed}>
                  <td>{entry.time}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.action}</td>
                  <td>{entry.detail}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={state().log.length === 0}>
          <p class="debug-empty">
            连接 server 后，编辑两个实例，再推送与拉取，观察独立 writer
            如何合并。
          </p>
        </Show>
      </section>
    </main>
  );
}
