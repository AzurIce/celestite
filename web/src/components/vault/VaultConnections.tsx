import { For, Show, createEffect, createSignal } from "solid-js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from "../ui";
import { Check, ChevronDown, Folder, X } from "../icons";
import { isDesktop } from "@/lib/desktop/platform";
import { supportsLocalDirectories } from "@/lib/vault/file-system-access";
import brandIcon from "../../../../icons/64x64.png";
import {
  type VaultManager,
  type VaultManagerSnapshot,
  type VaultConnection,
} from "@/lib/vault/manager";

export function VaultConnections(props: {
  manager: VaultManager;
  state: VaultManagerSnapshot;
}) {
  const [url, setUrl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<VaultConnection | null>(null);
  const [open, setOpen] = createSignal(false);
  let vaultTrigger: HTMLButtonElement | undefined;
  let dialogContent: HTMLDivElement | undefined;
  // The menu item opens the dialog programmatically, so move focus into it for
  // Escape handling and the focus trap that a trigger would normally install.
  createEffect(
    () => open(),
    (value) => {
      if (value) queueMicrotask(() => dialogContent?.focus());
    },
  );
  function permission(connection: VaultConnection) {
    const vault = props.state.opened.find(
      (vault) => vault.id === connection.id,
    );
    if (vault) return vault.readOnly ? "只读" : "可编辑";
    if (
      connection.kind === "remote" &&
      new URL(connection.url!).pathname.split("/").pop()?.startsWith("ro-")
    )
      return "只读";
    return "未连接";
  }
  function source(connection: VaultConnection) {
    if (connection.kind === "opfs") return "此浏览器";
    if (connection.kind === "native") return "本机";
    if (connection.kind === "directory")
      return connection.directoryPath ?? "本机目录";
    const url = new URL(connection.url!);
    return url.host + url.pathname.slice(0, url.pathname.lastIndexOf("/"));
  }
  function switcherLabel(connection: VaultConnection) {
    const sameName =
      props.state.connections.filter((other) => other.name === connection.name)
        .length > 1;
    const details = sameName ? [source(connection)] : [];
    const access = permission(connection);
    if (access === "只读" || (sameName && connection.kind === "remote"))
      details.push(access);
    return [connection.name, ...details].join(" · ");
  }
  function description(connection: VaultConnection) {
    if (connection.kind === "opfs")
      return "保存在此浏览器 · 默认 Vault，不可移除";
    if (connection.kind === "native")
      return "保存在本机 · 默认 Vault，不可移除";
    if (connection.kind === "directory")
      return connection.directoryPath
        ? `本机目录 · ${connection.directoryPath}`
        : "本机目录 · 文件直接保存到此目录";
    return `${new URL(connection.url!).origin} · ${permission(connection)}`;
  }
  function removalDescription(connection: VaultConnection) {
    if (connection.kind !== "remote")
      return "会先保存已打开的文件，目录中的文件仍保留。";
    if (permission(connection) === "只读")
      return "会关闭当前会话，服务器上的文件仍保留。";
    return "会确认编辑已发送并关闭当前会话，不会将更改保存到服务器磁盘。需要落盘的更改请先保存，服务器上的文件仍保留。";
  }
  const activeConnection = () =>
    props.state.connections.find(
      (connection) => connection.id === props.state.active?.id,
    ) ??
    props.state.connections.find(
      (connection) => connection.id === props.manager.defaultId,
    );
  const activeLabel = () => {
    const connection = activeConnection();
    return connection ? switcherLabel(connection) : "Vault";
  };
  const activeDescription = () => {
    const connection = activeConnection();
    return connection ? description(connection) : undefined;
  };
  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      if (await props.manager.connect(url())) {
        setUrl("");
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
    <div class="vault-connections-header">
      <img class="vault-brand-icon" src={brandIcon} alt="" aria-hidden="true" />
      <DropdownMenu placement="bottom-start" gutter={6}>
        <DropdownMenuTrigger
          ref={vaultTrigger}
          class="vault-switcher"
          aria-label="当前 Vault"
          aria-description={activeLabel()}
          title={activeDescription()}
          data-vault-id={props.state.active?.id ?? props.manager.defaultId}
          disabled={props.state.opening || busy()}
        >
          <span class="vault-switcher-label">{activeLabel()}</span>
          <ChevronDown class="vault-switcher-chevron" size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="vault-switcher-menu">
          <DropdownMenu.RadioGroup
            value={props.state.active?.id ?? props.manager.defaultId}
            onChange={(value) => void props.manager.activate(value)}
            aria-label="选择 Vault"
          >
            <For each={props.state.connections}>
              {(connection) => (
                <DropdownMenu.RadioItem
                  closeOnSelect
                  value={connection.id}
                  aria-label={switcherLabel(connection)}
                  class="ui-menu-item vault-switcher-item"
                >
                  <span class="vault-switcher-item-label">
                    {switcherLabel(connection)}
                  </span>
                  <Show
                    when={
                      (props.state.active?.id ?? props.manager.defaultId) ===
                      connection.id
                    }
                  >
                    <Check size={14} />
                  </Show>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            class="vault-switcher-manage"
            disabled={props.state.opening || busy()}
            onSelect={() => setOpen(true)}
          >
            <Folder size={15} />
            <span>管理 Vault</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={open()}
        onOpenChange={(value) => {
          if (!busy()) {
            setOpen(value);
            if (!value) {
              setError(null);
              setRemoving(null);
            }
          }
        }}
      >
        <DialogContent
          ref={dialogContent}
          class="vault-connections-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            vaultTrigger?.focus();
          }}
        >
          <DialogTitle>管理 Vault</DialogTitle>
          <DialogDescription>
            默认 Vault 始终保留。可打开本机目录，或连接服务器上的远端 Vault。
          </DialogDescription>
          <ul class="vault-connection-list">
            <For each={props.state.connections}>
              {(connection) => (
                <li>
                  <div class="vault-connection-copy">
                    <p class="text-ui-sm font-medium">{connection.name}</p>
                    <p
                      class="mt-1 break-all text-ui-sm text-secondary"
                      title={
                        connection.directoryPath
                          ? "从已授权目录开始的路径"
                          : undefined
                      }
                    >
                      {description(connection)}
                    </p>
                  </div>
                  <div class="vault-connection-actions">
                    <Show when={connection.kind === "remote"}>
                      <Button
                        size="sm"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(connection.url!)
                            .catch(() => setError("无法复制连接链接。"))
                        }
                      >
                        复制链接
                      </Button>
                    </Show>
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
                    <Show when={connection.id !== props.manager.defaultId}>
                      <IconButton
                        size="sm"
                        aria-label={`移除连接 ${connection.name}`}
                        disabled={busy()}
                        onClick={() => setRemoving(connection)}
                      >
                        <X size={14} />
                      </IconButton>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={removing()} keyed>
            {(connection) => (
              <div class="mt-4 rounded-control border border-solid border-border p-3">
                <p class="text-ui-sm">
                  移除“{connection.name}”的连接？
                  {removalDescription(connection)}
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
          <Show when={isDesktop() || supportsLocalDirectories()}>
            <div class="mt-5 border-t border-solid border-border pt-5">
              <Button
                disabled={busy() || props.state.opening}
                onClick={() => void openDirectory()}
              >
                打开本机目录
              </Button>
              <p class="mt-2 text-ui-sm text-secondary">
                {isDesktop()
                  ? "选择本机目录，已有文件可直接编辑，连接会自动保留。"
                  : "选择目录并授权读写，已有文件可直接编辑。重新打开时可能需要再次授权。"}
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
              placeholder="https://example.com/ro-<key>"
              value={url()}
              onInput={(event) => setUrl(event.currentTarget.value)}
              disabled={busy()}
            />
            <p class="mt-2 text-ui-sm text-secondary">
              粘贴宿主提供的只读或编辑链接。
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
    </div>
  );
}
