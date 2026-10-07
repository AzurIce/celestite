import { test } from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { DocumentPresence } from "../../src/lib/editor/client/presence";
import {
  anchorPositions,
  projectSelection,
} from "../../src/lib/editor/presence";
import {
  collaboratorField,
  setCollaborators,
} from "../../src/components/editor/collaborators";
import type { EditorClient } from "../../src/lib/editor/rpc";
import type {
  Anchor,
  CollaborationSnapshot,
  RemoteSelection,
  Version,
  ViewEdit,
} from "../../src/lib/editor/contract";

const version = (clock = 4): Version => ({
  identity: { document_id: "doc", history_id: "history" },
  clocks: { "1": clock },
});
const anchor = (offset: number) => ({ offset }) as unknown as Anchor;
const members = (clock = 4): CollaborationSnapshot => ({
  sessionId: "me",
  sequence: clock,
  members: [
    {
      sessionId: "me",
      name: "我",
      color: "#2563eb",
      readOnly: false,
      documents: ["doc"],
      views: [],
    },
    {
      sessionId: "peer",
      name: "访客 ABCD",
      color: "#0d9488",
      readOnly: true,
      documents: ["doc"],
      views: [
        {
          viewId: "remote",
          documentId: "doc",
          focused: true,
          selection: {
            version: version(clock),
            mainIndex: 0,
            ranges: [{ anchor: anchor(1), head: anchor(3) }],
          },
        },
      ],
    },
  ],
});
const record = () => ({
  id: "doc",
  content: "A😀B",
  acceptedContent: "A😀B",
  acceptedVersion: version(),
  inputs: [] as ViewEdit[],
  blocked: false,
  collaborators: [] as RemoteSelection[],
});
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 70));

test("remote Unicode selections map through optimistic edits without moving the local selection", () => {
  const member: RemoteSelection = {
    sessionId: "peer",
    viewId: "remote",
    name: "访客",
    color: "#2563eb",
    readOnly: true,
    focused: true,
    ranges: [{ anchor: 1, head: 3 }],
    mainIndex: 0,
  };
  const state = EditorState.create({
    doc: "A😀B",
    selection: { anchor: 4 },
    extensions: [collaboratorField],
  });
  const decorated = state.update({
    effects: setCollaborators.of([member]),
  }).state;
  assert.equal(decorated.doc.toString(), state.doc.toString());
  assert.deepEqual(decorated.selection, state.selection);
  const moved = decorated.update({ changes: { from: 0, insert: "前" } }).state;
  assert.deepEqual(moved.field(collaboratorField)[0].ranges, [
    { anchor: 2, head: 4 },
  ]);
  const removed = moved.update({ changes: { from: 2, to: 4 } }).state;
  assert.deepEqual(removed.field(collaboratorField)[0].ranges, [
    { anchor: 2, head: 2 },
  ]);
  assert.deepEqual(
    removed
      .update({ effects: setCollaborators.of([]) })
      .state.field(collaboratorField),
    [],
  );
  assert.deepEqual(
    projectSelection(
      {
        ranges: [
          { anchor: 3, head: 1 },
          { anchor: 4, head: 4 },
        ],
        mainIndex: 1,
      },
      4,
      [{ edits: [{ from: 0, to: 0, insert: "前" }] }],
    ),
    {
      ranges: [
        { anchor: 4, head: 2 },
        { anchor: 5, head: 5 },
      ],
      mainIndex: 1,
    },
  );
  assert.deepEqual(
    anchorPositions({
      ranges: [
        { anchor: 3, head: 1 },
        { anchor: 4, head: 4 },
      ],
      mainIndex: 0,
    }),
    [
      [3, "before"],
      [1, "after"],
      [4, "after"],
      [4, "after"],
    ],
  );
});

test("presence waits for text dependencies and discards resolution after a peer leaves", async () => {
  let resolve!: (value: unknown) => void;
  let requests = 0,
    changes = 0;
  const client = {
    request: () => {
      requests++;
      return new Promise((done) => {
        resolve = done;
      });
    },
  } as unknown as EditorClient;
  const presence = new DocumentPresence(client, () => {
    changes++;
  });
  const doc = record();
  presence.refresh(members(5), [doc], true);
  assert.equal(requests, 0);
  doc.acceptedVersion = version(5);
  presence.refresh(members(5), [doc], true);
  assert.equal(requests, 1);
  const left = members(6);
  left.members.pop();
  presence.refresh(left, [doc], true);
  resolve([version(5), [{ offset: 1 }, { offset: 3 }]]);
  await Promise.resolve();
  assert.deepEqual(doc.collaborators, []);
  assert.equal(changes, 0);
  presence.close();
});

test("received anchors resolve against accepted text and project through pending input; disconnect clears them", async () => {
  let changed!: () => void;
  const done = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const client = {
    request: async () => [version(), [{ offset: 1 }, { offset: 3 }]],
  } as unknown as EditorClient;
  const presence = new DocumentPresence(client, changed);
  const doc = record();
  doc.content = "前A😀B";
  doc.inputs = [
    {
      edits: [{ from: 0, to: 0, insert: "前" }],
      content: doc.content,
      before: { ranges: [{ anchor: 0, head: 0 }], mainIndex: 0 },
      after: { ranges: [{ anchor: 1, head: 1 }], mainIndex: 0 },
      userEvent: "input",
    },
  ];
  presence.refresh(members(), [doc], true);
  await done;
  assert.deepEqual(doc.collaborators[0].ranges, [{ anchor: 2, head: 4 }]);
  assert.equal(doc.collaborators[0].readOnly, true);
  presence.refresh(undefined, [doc], false);
  assert.deepEqual(doc.collaborators, []);
  presence.close();
});

test("outgoing presence coalesces motion and sends offsets only after input acceptance and IME completion", async () => {
  const requests: { method: string; params: any }[] = [];
  const client = {
    request: async (method: string, params: any) => {
      requests.push({ method, params });
    },
  } as unknown as EditorClient;
  const presence = new DocumentPresence(client, () => {});
  const doc = record();
  try {
    presence.refresh(undefined, [doc], true);
    doc.content = "A😀BX";
    doc.inputs = [{ edits: [{ from: 4, to: 4, insert: "X" }] } as ViewEdit];
    for (const head of [1, 3, 5])
      await presence.setView("local", "doc", true, {
        content: doc.content,
        selection: { ranges: [{ anchor: head, head }], mainIndex: 0 },
      });
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].params.selection, null);
    doc.inputs = [];
    doc.acceptedContent = doc.content;
    doc.acceptedVersion = version(5);
    presence.refresh(undefined, [doc], true);
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].params.selection.selection.ranges[0].head, 5);
    assert.deepEqual(requests[1].params.selection.version, version(5));
    presence.composition("doc", true);
    await settle();
    assert.equal(requests.at(-1)?.params.selection, null);
    presence.composition("doc", false);
    await settle();
    assert.equal(requests.at(-1)?.params.selection.selection.ranges[0].head, 5);
    await presence.setView("local", null, false);
    assert.equal(requests.at(-1)?.params.documentId, null);
  } finally {
    presence.close();
  }
});

test("a delayed resolution cannot attach to a closed and reopened document projection", async () => {
  const pending: ((result: unknown) => void)[] = [];
  const client = {
    request: () => new Promise((resolve) => pending.push(resolve)),
  } as unknown as EditorClient;
  const first = record(),
    reopened = record();
  let current = first;
  const presence = new DocumentPresence(client, () =>
    presence.refresh(members(), [current], true),
  );
  try {
    presence.refresh(members(), [first], true);
    current = reopened;
    presence.refresh(members(), [reopened], true);
    assert.equal(pending.length, 1);
    pending[0]([version(), [{ offset: 1 }, { offset: 3 }]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(first.collaborators.length, 0);
    assert.equal(reopened.collaborators.length, 0);
    assert.equal(pending.length, 2);
    pending[1]([version(), [{ offset: 1 }, { offset: 3 }]]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reopened.collaborators[0].sessionId, "peer");
    presence.mapProjection(reopened, reopened.content, "前A😀B", [
      { from: 0, to: 0, insert: "前" },
    ]);
    assert.deepEqual(reopened.collaborators[0].ranges, [
      { anchor: 2, head: 4 },
    ]);
  } finally {
    presence.close();
  }
});
