import { readFile } from "node:fs/promises";
import init, {
  EditorBinding,
  PreviewBinding,
} from "../../src/lib/editor/generated/celestite_core";
import { createBrowserIo } from "../../src/lib/editor/local/io";
import { EditorHost } from "../../src/lib/editor/runtime/host";
import {
  serveEditor,
  type EditorServicePort,
} from "../../src/lib/editor/runtime/service";
import { EditorClient, type MessageTransport } from "../../src/lib/editor/rpc";
import { WorkerDocuments } from "../../src/lib/editor/client/documents";
import type {
  EditorDocuments,
  InstanceIdentity,
  WorkerMessage,
  WorkerRequest,
} from "../../src/lib/editor/contract";
import { VaultError } from "../../src/lib/vault/errors";
import type { VaultBackend } from "../../src/lib/vault/types";
import { PreviewResources } from "../../src/lib/preview/resources";

const ready = readFile(
  new URL(
    "../../src/lib/editor/generated/celestite_core_bg.wasm",
    import.meta.url,
  ),
).then((bytes) => init({ module_or_path: bytes }));

/** Only IO is faked. All editing, history, recovery and commands run production code. */
export class MemoryHistory {
  readonly files = new Map<string, Uint8Array>();
  failWrites = false;
  async bytes(path: string) {
    return this.files.get(path)?.slice() ?? null;
  }
  async put(path: string, value: Uint8Array) {
    if (this.failWrites) throw new VaultError("IO", "history write failed");
    this.files.set(path, value.slice());
  }
  async json<T>(path: string): Promise<T | null> {
    const bytes = await this.bytes(path);
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null;
  }
  async putJson(path: string, value: unknown) {
    await this.put(path, new TextEncoder().encode(JSON.stringify(value)));
  }
}

export async function createTestEditor(
  backend: VaultBackend,
  history = new MemoryHistory(),
  identity: InstanceIdentity = {
    instanceId: crypto.randomUUID(),
    vault: { vaultId: crypto.randomUUID(), historyId: crypto.randomUUID() },
  },
) {
  await ready;
  const listeners = new Set<(event: MessageEvent<WorkerMessage>) => void>();
  let incoming!: (event: MessageEvent<WorkerRequest>) => void;
  const transport: MessageTransport = {
    postMessage: (data) =>
      queueMicrotask(() => incoming(new MessageEvent("message", { data }))),
    addEventListener: (_, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_, listener) => {
      listeners.delete(listener);
    },
  };
  const port: EditorServicePort = {
    postMessage: (data) =>
      queueMicrotask(() => {
        for (const listener of listeners)
          listener(new MessageEvent("message", { data }));
      }),
    addEventListener: (_, listener) => {
      incoming = listener;
    },
  };
  const client = new EditorClient(transport);
  const lifetime = serveEditor(port, async (emit, schedule) => {
    const core = await EditorBinding.open(
      JSON.stringify(identity),
      createBrowserIo(history, backend),
      false,
    );
    return {
      identity,
      host: new EditorHost(core, backend, emit, schedule),
      previewBinding: new PreviewBinding(),
      previewResources: new PreviewResources(backend),
      dispose: () => core.free(),
    };
  }).catch((error) => client.fail(error));
  await client.ready;
  const documents = new WorkerDocuments(client, () => {
    void lifetime;
  });
  return {
    identity,
    documents,
    backend: documents.treeBackend,
    history,
    lifetime,
  };
}

export function replaceText(
  documents: EditorDocuments,
  id: string,
  text: string,
): boolean {
  const before = documents
    .snapshot()
    .documents.find((document) => document.id === id)!;
  return documents.edit(id, {
    edits: [{ from: 0, to: before.content.length, insert: text }],
    content: text,
    userEvent: "input.replace",
    before: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
    after: {
      ranges: [{ anchor: text.length, head: text.length }],
      mainIndex: 0,
    },
  });
}
