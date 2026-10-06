import type { EditorDocuments } from "../../src/lib/editor/contract";
import type {
  DocumentSnapshot,
  DocumentsSnapshot,
} from "../../src/lib/editor/documents";
import type { VaultBackend, VaultPath } from "../../src/lib/vault";

interface Record {
  id: string;
  path: VaultPath;
  content: string;
  savedContent: string;
}

/** Minimal EditorDocuments double for manager tests: in-memory records over a backend. */
export function fakeEditorDocuments(backend: VaultBackend): EditorDocuments {
  const records = new Map<string, Record>();
  const listeners = new Set<(state: DocumentsSnapshot) => void>();
  let nextId = 0;
  let activeId: string | null = null;

  const document = (record: Record): DocumentSnapshot => ({
    id: record.id,
    path: record.path,
    content: record.content,
    dirty: record.content !== record.savedContent,
    saving: false,
    locked: false,
    error: null,
    conflict: false,
    reloadVersion: 0,
    readOnlyReason: null,
    canPreview: true,
    lineEnding: "\n",
    bom: false,
  });
  const snapshot = (): DocumentsSnapshot => ({
    activeId,
    documents: [...records.values()].map(document),
    loadingPath: null,
    openError: null,
    activation: 0,
    conflictPrompt: null,
    conflictResolving: false,
    conflictError: null,
  });
  const notify = () => listeners.forEach((listener) => listener(snapshot()));

  async function persist(record: Record): Promise<boolean> {
    if (record.content === record.savedContent) return true;
    try {
      await backend.writeFile(
        record.path,
        new TextEncoder().encode(record.content),
        { mode: "replace" },
      );
      record.savedContent = record.content;
      return true;
    } catch {
      return false;
    }
  }
  async function saveAll() {
    for (const record of records.values())
      if (!(await persist(record))) return false;
    return true;
  }

  return {
    treeBackend: backend,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot,
    async open(path) {
      const stat = await backend.stat(path);
      if (!stat || stat.kind !== "file") return false;
      const content = new TextDecoder().decode(await backend.readFile(path));
      const record: Record = {
        id: `document-${++nextId}`,
        path,
        content,
        savedContent: content,
      };
      records.set(record.id, record);
      activeId = record.id;
      notify();
      return true;
    },
    activate(id) {
      activeId = id;
      notify();
    },
    update(id, content) {
      const record = records.get(id);
      if (!record) return false;
      record.content = content;
      notify();
      return true;
    },
    async save(id = activeId) {
      const record = id ? records.get(id) : undefined;
      return record ? persist(record) : false;
    },
    saveAll,
    async requestSave(id = activeId) {
      return this.save(id);
    },
    async requestCloseDocument(id) {
      return this.closeDocument(id);
    },
    async closeDocument(id) {
      const record = records.get(id);
      if (!record) return false;
      if (!(await persist(record))) return false;
      records.delete(id);
      if (activeId === id) activeId = null;
      notify();
      return true;
    },
    async resolveConflict() {
      return true;
    },
    has(id) {
      return records.has(id);
    },
    hasUnsaved() {
      return [...records.values()].some(
        (record) => record.content !== record.savedContent,
      );
    },
    async close() {
      await saveAll();
      await backend.close();
    },
  };
}
