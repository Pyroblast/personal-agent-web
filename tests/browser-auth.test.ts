import { test } from "node:test";
import assert from "node:assert/strict";
import { createCredentials, AUTH_KEY } from "../ui/auth.js";
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}
test("verified legacy authorization survives a new tab/browser session without a token URL", () => {
  const saved = storage(),
    tab = storage();
  tab.setItem(AUTH_KEY, "synthetic-token");
  const first = createCredentials(saved, tab);
  assert.equal(first.current(), "synthetic-token");
  assert.equal(saved.getItem(AUTH_KEY), null);
  first.verified(first.current());
  assert.equal(tab.getItem(AUTH_KEY), null);
  const reopened = createCredentials(saved, storage());
  assert.equal(reopened.current(), "synthetic-token");
  reopened.forget();
  assert.equal(createCredentials(saved, storage()).current(), "");
});
test("invalid or stale responses cannot persist an unverified link or erase newer authorization", () => {
  const saved = storage(),
    tab = storage(),
    auth = createCredentials(saved, tab);
  auth.offer("invalid");
  auth.rejected("invalid");
  assert.equal(saved.getItem(AUTH_KEY), null);
  assert.equal(auth.current(), "");
  auth.offer("new");
  auth.verified("old");
  auth.rejected("old");
  assert.equal(auth.current(), "new");
  assert.equal(saved.getItem(AUTH_KEY), null);
  auth.verified("new");
  auth.rejected("old");
  assert.equal(saved.getItem(AUTH_KEY), "new");
  auth.rejected("new");
  assert.equal(createCredentials(saved, storage()).current(), "");
});
test("storage denied retains current-page access without claiming persistence", () => {
  const blocked = {
    getItem: () => {
      throw Error("blocked");
    },
    setItem: () => {
      throw Error("blocked");
    },
    removeItem: () => {
      throw Error("blocked");
    },
  };
  const auth = createCredentials(blocked, blocked);
  auth.offer("synthetic");
  assert.equal(auth.verified("synthetic"), false);
  assert.equal(auth.current(), "synthetic");
});
