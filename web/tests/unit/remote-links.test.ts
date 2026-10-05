import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVaultUrl, openHttpVault } from "../../src/lib/vault/http";

const random = "A".repeat(43);
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
