import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMargins } from "../margins.js";

test("旧宽度迁移为对称边距，默认保留原阅读宽度", () => {
  assert.deepEqual(normalizeMargins(), { marginLeft: 12, marginRight: 12, marginsLinked: true, contentWidth: 76 });
  assert.equal(normalizeMargins({ contentWidth: 40 }).marginLeft, 30);
  assert.equal(normalizeMargins({ contentWidth: 100 }).marginRight, 0);
});

test("独立边距更新保留另一侧并限制最小阅读宽度", () => {
  const current = { marginLeft: 20, marginRight: 5, marginsLinked: false };
  assert.deepEqual(normalizeMargins(current, { marginRight: 60 }), { marginLeft: 20, marginRight: 40, marginsLinked: false, contentWidth: 40 });
  assert.equal(normalizeMargins(current, { marginLeft: -10 }).marginLeft, 0);
  assert.equal(normalizeMargins(current, { marginRight: Infinity }).marginRight, 12);
});

test("旧客户端宽度更新转换为对称边距，新快照保留非对称边距", () => {
  const current = { marginLeft: 20, marginRight: 5, marginsLinked: false };
  assert.deepEqual(normalizeMargins(current, { contentWidth: 80 }), { marginLeft: 10, marginRight: 10, marginsLinked: true, contentWidth: 80 });
  assert.deepEqual(normalizeMargins({}, { ...current, contentWidth: 75 }), { ...current, contentWidth: 75 });
});
