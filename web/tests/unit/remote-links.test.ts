import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HttpVaultBackend,
  normalizeVaultUrl,
  openHttpVault,
} from "../../src/lib/vault/http";
import { VaultError } from "../../src/lib/vault/errors";
import { vaultPath } from "../../src/lib/vault/path";

const random = "A".repeat(43);
function pageOrigin(origin: string, protocol = new URL(origin).protocol) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin, protocol },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  };
}
test("share URL normalization preserves deployment prefixes and the complete key", () => {
  for (const key of [random, `ro-${random}`]) {
    assert.equal(
      normalizeVaultUrl(`https://host/deploy/${key}///`),
      `https://host/deploy/${key}`,
    );
  }
  for (const url of [
    "https://host/api/v1/vaults/notes",
    `https://user:pass@host/${random}`,
    `https://host/${random}?permission=edit`,
    `https://host/${random}#token`,
    `https://host/${random}?`,
    `https://host/${random}#`,
    `https://host/ro-${"A".repeat(40)}`,
    `https://host/${"A".repeat(42)}B`,
  ])
    assert.throws(() => normalizeVaultUrl(url));
});

test("HTTP requests append API paths and negotiate identity independently of the key", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return Response.json({
      protocol: "celestite-vault",
      version: 1,
      shareId: "share-id",
      name: "Notes",
      readOnly: true,
      vaultIdentity: { id: "vault-id", historyId: "history-id" },
      capabilities: { watch: true, conditionalWrite: true },
    });
  }) as typeof fetch;
  try {
    const { backend, descriptor } = await openHttpVault(
      `https://host/deploy/ro-${random}`,
    );
    assert.equal(descriptor.shareId, "share-id");
    assert.equal(descriptor.vaultIdentity?.id, "vault-id");
    assert.equal(requests[0].url, `https://host/deploy/ro-${random}/api/v1`);
    assert.equal(
      new Headers(requests[0].init?.headers).has("Authorization"),
      false,
    );
    assert.equal(requests[0].init?.referrerPolicy, "no-referrer");
    await backend.close();
  } finally {
    globalThis.fetch = original;
  }
});

test("failed HTTP connections from HTTPS pages and blob Workers explain mixed content without exposing the share key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    for (const protocol of ["https:", "blob:"]) {
      const restore = pageOrigin("https://azurice.github.io", protocol);
      try {
        await assert.rejects(
          openHttpVault(`http://203.0.113.1:3250/${random}`),
          (error) =>
            error instanceof VaultError &&
            error.code === "IO" &&
            error.message.includes("HTTPS") &&
            !error.message.includes(random),
        );
      } finally {
        restore();
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("successful local-network HTTP requests remain available when the browser permits them", async () => {
  const original = globalThis.fetch;
  const restore = pageOrigin("https://azurice.github.io");
  globalThis.fetch = (async () =>
    Response.json({
      protocol: "celestite-vault",
      version: 1,
      shareId: "local",
      name: "Home",
      readOnly: false,
      vaultIdentity: { id: "vault-id", historyId: "history-id" },
      capabilities: { watch: false, conditionalWrite: true },
    })) as typeof fetch;
  try {
    const { backend, descriptor } = await openHttpVault(
      `http://192.168.2.11:3250/${random}`,
    );
    assert.equal(descriptor.name, "Home");
    await backend.close();
  } finally {
    globalThis.fetch = original;
    restore();
  }
});

test("HTTPS transport guidance preserves uncertain write results and normal network errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    const restore = pageOrigin("https://azurice.github.io");
    try {
      const backend = new HttpVaultBackend(`http://203.0.113.1:3250/${random}`);
      await assert.rejects(
        backend.writeFile(vaultPath("a.md"), new Uint8Array([1]), {
          mode: "create",
        }),
        (error) =>
          error instanceof VaultError &&
          error.message.includes("写操作可能已提交") &&
          error.message.includes("HTTPS"),
      );
      await backend.close();
      await assert.rejects(
        openHttpVault(`https://host/${random}`),
        (error) =>
          error instanceof VaultError &&
          error.message === "远端请求未完成，请检查连接。",
      );
    } finally {
      restore();
    }
    const restoreHttp = pageOrigin("http://localhost:1430");
    try {
      await assert.rejects(
        openHttpVault(`http://203.0.113.1:3250/${random}`),
        (error) =>
          error instanceof VaultError &&
          error.message === "远端请求未完成，请检查连接。",
      );
    } finally {
      restoreHttp();
    }
  } finally {
    globalThis.fetch = original;
  }
});
