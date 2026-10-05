import { For, Show, createSignal } from "solid-js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  IconButton,
} from "../ui";
import { Folder, X } from "../icons";
import { supportsLocalDirectories } from "@/lib/vault/file-system-access";
import {
  DEFAULT_VAULT_ID,
  type VaultManager,
  type VaultManagerSnapshot,
  type VaultConnection,
} from "@/lib/vault/manager";

export function VaultConnections(props: {
  manager: VaultManager;
  state: VaultManagerSnapshot;
}) {
  const [url, setUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<VaultConnection | null>(null);
  const [open, setOpen] = createSignal(false);
  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      if (await props.manager.connect(url(), token())) {
        setUrl("");
        setToken("");
        setOpen(false);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function openDirectory() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      if (await props.manager.openDirectory()) setOpen(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove(connection: VaultConnection) {
    setBusy(true);
    setError(null);
    try {
      await props.manager.removeConnection(connection.id);
      setRemoving(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <select
        class="vault-switcher"
        aria-label="当前 Vault"
        value={props.state.active?.id ?? DEFAULT_VAULT_ID}
        disabled={props.state.opening || busy()}
        onChange={(event) =>
          void props.manager.activate(event.currentTarget.value)
        }
      >
        <For each={props.state.connections}>
          {(connection) => (
            <option value={connection.id}>{connection.name}</option>
          )}
        </For>
      </select>
      <Dialog
        open={open()}
        onOpenChange={(value) => {
          if (!busy()) {
            setOpen(value);
            if (!value) {
              setToken("");
              setError(null);
              setRemoving(null);
            }
          }
        }}
      >
        <DialogTrigger
          as={IconButton}
          size="sm"
          aria-label="管理 Vault"
          title="管理 Vault"
        >
          <Folder size={15} />
        </DialogTrigger>
        <DialogContent class="vault-connections-dialog">
          <DialogTitle>管理 Vault</DialogTitle>
          <DialogDescription>
            默认 Vault 始终保留。可打开本机目录，或连接服务器上的远端 Vault。
          </DialogDescription>
          <ul class="vault-connection-list">
            <For each={props.state.connections}>
              {(connection) => (
                <li>
                  <div class="min-w-0 flex-1">
                    <p class="text-ui-sm font-medium">{connection.name}</p>
                    <p class="mt-1 break-all text-ui-sm text-secondary">
                      {connection.kind === "opfs"
                        ? "默认本地 Vault · 不可移除"
                        : connection.kind === "directory"
                          ? "本机目录 · 文件直接保存到此目录"
                          : connection.url}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={busy() || props.state.opening}
                    onClick={async () => {
                      if (await props.manager.activate(connection.id))
                        setOpen(false);
                    }}
                  >
                    打开
                  </Button>
                  <Show when={connection.kind !== "opfs"}>
                    <IconButton
                      size="sm"
                      aria-label={`移除连接 ${connection.name}`}
                      disabled={busy()}
                      onClick={() => setRemoving(connection)}
                    >
                      <X size={14} />
                    </IconButton>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={removing()} keyed>
            {(connection) => (
              <div class="mt-4 rounded-control border border-solid border-border p-3">
                <p class="text-ui-sm">
                  移除“{connection.name}
                  ”的连接？会先保存已打开的文件，目录中的文件仍保留。
                </p>
                <div class="mt-3 flex justify-end gap-2">
                  <Button
                    size="sm"
                    disabled={busy()}
                    onClick={() => setRemoving(null)}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy()}
                    onClick={() => void remove(connection)}
                  >
                    确认移除连接
                  </Button>
                </div>
              </div>
            )}
          </Show>
          <Show when={supportsLocalDirectories()}>
            <div class="mt-5 border-t border-solid border-border pt-5">
              <Button
                disabled={busy() || props.state.opening}
                onClick={() => void openDirectory()}
              >
                打开本机目录
              </Button>
              <p class="mt-2 text-ui-sm text-secondary">
                选择目录并授权读写，已有文件可直接编辑。重新打开时可能需要再次授权。
              </p>
            </div>
          </Show>
          <form
            class="mt-5 border-t border-solid border-border pt-5"
            onSubmit={connect}
          >
            <label class="text-ui-sm font-medium" for="remote-vault-url">
              连接远端 Vault
            </label>
            <input
              id="remote-vault-url"
              class="ui-input mt-2 w-full"
              type="url"
              required
              placeholder="https://example.com/api/v1/vaults/notes"
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
              disabled={busy()}
            />
            <label
              class="mt-3 block text-ui-sm text-secondary"
              for="remote-vault-token"
            >
              访问令牌（可选）
            </label>
            <input
              id="remote-vault-token"
              class="ui-input mt-2 w-full"
              type="password"
              autocomplete="off"
              value={token()}
              onInput={(event) => setToken(event.currentTarget.value)}
              disabled={busy()}
            />
            <p class="mt-2 text-ui-sm text-secondary">
              令牌仅用于本次会话。刷新后可通过同一 URL 重新认证。
            </p>
            <div class="mt-4 flex justify-end">
              <Button type="submit" disabled={busy() || props.state.opening}>
                {busy() ? "正在连接…" : "连接"}
              </Button>
            </div>
          </form>
          <Show when={error() || props.state.error}>
            <p role="alert" class="mt-4 text-ui-sm text-danger">
              {error() || props.state.error}
            </p>
          </Show>
          <Show when={props.state.persistenceError}>
            <p role="status" class="mt-4 text-ui-sm text-secondary">
              {props.state.persistenceError}
            </p>
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
}
