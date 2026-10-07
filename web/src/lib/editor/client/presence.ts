import type { EditorClient } from "../rpc";
import type {
  CollaborationSnapshot,
  RemoteSelection,
  Version,
  ViewEdit,
  ViewSelection,
} from "../contract";
import {
  boundedSelection,
  mapViewSelection,
  projectSelection,
} from "../presence";
import { containsVersion } from "../remote/session";
import { sameVersion } from "../view-changes";

interface Projection {
  id: string;
  content: string;
  acceptedContent: string;
  acceptedVersion?: Version;
  inputs: ViewEdit[];
  blocked: boolean;
  collaborators?: RemoteSelection[];
}
interface LocalView {
  documentId: string;
  focused: boolean;
  position?: ViewSelection;
  sent?: string;
}

/** Maps presence between accepted core history and the optimistic UI projection. */
export class DocumentPresence {
  private views = new Map<string, LocalView>();
  private composing = new Set<string>();
  private resolutions = new Map<string, string>();
  private resolving = new Set<string>();
  private projections = new Map<string, Projection>();
  private timer?: ReturnType<typeof setTimeout>;
  private sessionId?: string;
  private closed = false;
  private online = false;
  private records: Projection[] = [];
  constructor(
    private client: EditorClient,
    private changed: () => void,
  ) {}
  setView(
    viewId: string,
    documentId: string | null,
    focused: boolean,
    position?: ViewSelection,
  ) {
    if (this.closed) return Promise.resolve();
    if (documentId === null) {
      this.views.delete(viewId);
      if (!this.online) return Promise.resolve();
      return this.client.request("set_view", {
        viewId,
        documentId,
        focused: false,
        selection: null,
      });
    }
    const previous = this.views.get(viewId);
    this.views.set(viewId, {
      documentId,
      focused,
      position,
      sent: previous?.sent,
    });
    this.schedule();
    return Promise.resolve();
  }
  composition(id: string, active: boolean) {
    if (active) this.composing.add(id);
    else this.composing.delete(id);
    this.schedule();
  }
  mapProjection(
    record: Projection,
    before: string,
    after: string,
    edits: ViewEdit["edits"],
  ) {
    record.collaborators = record.collaborators?.map((member) => ({
      ...member,
      ...mapViewSelection(member, before.length, edits),
    }));
    for (const view of this.views.values()) {
      if (view.documentId !== record.id || view.position?.content !== before)
        continue;
      view.position = {
        content: after,
        selection: mapViewSelection(
          view.position.selection,
          before.length,
          edits,
        ),
      };
    }
  }
  refresh(
    members: CollaborationSnapshot | undefined,
    records: Iterable<Projection>,
    online: boolean,
  ) {
    if (this.closed) return;
    this.records = [...records];
    this.online = online;
    if (this.sessionId !== members?.sessionId) {
      this.sessionId = members?.sessionId;
      for (const view of this.views.values()) view.sent = undefined;
      this.resolutions.clear();
    }
    const live = new Set<string>();
    for (const record of this.records) {
      live.add(record.id);
      if (this.projections.get(record.id) !== record)
        this.resolutions.delete(record.id);
      this.projections.set(record.id, record);
      const version = record.acceptedVersion;
      const key = JSON.stringify([
        online,
        members?.sessionId,
        members?.sequence,
        version,
        record.inputs.map((input) => input.edits),
      ]);
      if (this.resolutions.get(record.id) === key) continue;
      this.resolutions.set(record.id, key);
      // Clear removed peers immediately, including those with unresolved anchors.
      const remote =
        online && members && version
          ? members.members
              .filter((member) => member.sessionId !== members.sessionId)
              .flatMap((member) =>
                member.views
                  .filter(
                    (view) =>
                      view.documentId === record.id &&
                      view.selection &&
                      containsVersion(version, view.selection.version),
                  )
                  .map((view) => ({
                    member,
                    view,
                    selection: view.selection!,
                  })),
              )
          : [];
      record.collaborators =
        record.collaborators?.filter((item) =>
          remote.some(
            ({ member, view }) =>
              member.sessionId === item.sessionId &&
              view.viewId === item.viewId,
          ),
        ) ?? [];
      if (!remote.length || !version) continue;
      if (this.resolving.has(record.id)) continue;
      this.resolving.add(record.id);
      const anchors = remote.flatMap(({ selection }) =>
        selection.ranges.flatMap((range) => [range.anchor, range.head]),
      );
      // Each checkpoint is already contained in this accepted version. Passing
      // that whole version also detects a late core result after a UI change.
      void this.client
        .request("resolve_anchors", {
          id: record.id,
          checkpoint: version,
          anchors,
        })
        .then(([resolvedVersion, resolved]) => {
          if (
            this.closed ||
            this.projections.get(record.id) !== record ||
            this.resolutions.get(record.id) !== key ||
            !record.acceptedVersion ||
            !sameVersion(record.acceptedVersion, resolvedVersion)
          )
            return;
          let offset = 0;
          record.collaborators = remote.map(({ member, view, selection }) => {
            const ranges = selection.ranges.map(() => ({
              anchor: resolved[offset++].offset,
              head: resolved[offset++].offset,
            }));
            const projected = projectSelection(
              { ranges, mainIndex: selection.mainIndex },
              record.acceptedContent.length,
              record.inputs,
            );
            return {
              ...projected,
              sessionId: member.sessionId,
              viewId: view.viewId,
              name: member.name,
              color: member.color,
              focused: view.focused,
              readOnly: member.readOnly,
            };
          });
          this.changed();
        })
        .catch(() => {
          // A text import can precede its main-thread event. The next accepted
          // document update retries; presence failure never blocks editing.
        })
        .finally(() => {
          this.resolving.delete(record.id);
          if (
            !this.closed &&
            this.resolutions.has(record.id) &&
            (this.projections.get(record.id) !== record ||
              this.resolutions.get(record.id) !== key)
          ) {
            this.resolutions.delete(record.id);
            this.changed();
          }
        });
    }
    for (const id of this.resolutions.keys())
      if (!live.has(id)) this.resolutions.delete(id);
    for (const id of this.projections.keys())
      if (!live.has(id)) this.projections.delete(id);
    this.schedule();
  }
  private schedule() {
    if (this.closed || !this.online || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed || !this.online) return;
      for (const [viewId, view] of this.views) {
        const record = this.records.find(
          (record) => record.id === view.documentId,
        );
        const position = view.position;
        const selection =
          record?.acceptedVersion &&
          !record.inputs.length &&
          !record.blocked &&
          !this.composing.has(record.id) &&
          position?.content === record.acceptedContent
            ? {
                version: record.acceptedVersion,
                selection: boundedSelection(position.selection),
              }
            : null;
        const params = {
          viewId,
          documentId: view.documentId,
          focused: view.focused,
          selection,
        };
        const key = JSON.stringify(params);
        if (view.sent === key) continue;
        view.sent = key;
        void this.client.request("set_view", params).catch(() => {});
      }
    }, 50);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.views.clear();
    this.resolutions.clear();
    this.projections.clear();
  }
}
