import { test } from "node:test";
import assert from "node:assert/strict";
import { sendsMessage, dayKey } from "../ui/chat-interaction.js";
test("send shortcut protects multiline input, composition and held keys", () => {
  const key = { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.equal(sendsMessage(key), false);
  assert.equal(sendsMessage({ ...key, metaKey: true }), true);
  assert.equal(sendsMessage({ ...key, ctrlKey: true }), true);
  for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }])
    assert.equal(sendsMessage({ ...key, metaKey: true, ...guard }), false);
});
test("date groups use the same Beijing day across device timezones", () => {
  assert.equal(dayKey(Date.parse("2026-11-03T16:01:00Z")), "2026-11-04");
  assert.equal(dayKey(Date.parse("2026-11-03T15:59:00Z")), "2026-11-03");
});
