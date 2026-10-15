import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const functionNames = [
  "isVerticallyMirrored", "updateMirror", "applyResponsiveLayout", "getLayoutMetrics",
  "getLineAnchor", "scrollTopForAnchor", "startScrollTop", "localScrollSpeed", "scrollVelocity"
];
const functions = functionNames.map((name) => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  function ", start + 1);
  assert.ok(start >= 0 && end > start, `找不到函数 ${name}`);
  return source.slice(start, end);
}).join("\n");

function fixture({ vertical = false, horizontal = false, reverse = false, follow = true, localVertical = false, editing = false } = {}) {
  const properties = {};
  const control = () => ({ style: {}, setAttribute() {}, classList: { toggle() {} } });
  const elements = {
    stage: { ...control(), clientWidth: 1000, clientHeight: 600, scrollHeight: 2400, scrollTop: 360 },
    promptContent: { ...control(), offsetTop: 0 },
    mirrorBadge: control(), followRoomMirror: control(), displayFollowMirror: control()
  };
  const context = vm.createContext({
    state: { mirrorVertical: vertical, mirrorHorizontal: horizontal, reverseScroll: reverse, guidePosition: 30, fontSize: 80, lineHeight: 1.5, letterSpacing: 1, scrollSpeed: 45, script: "稿件" },
    localView: { followRoomMirror: follow, mirrorVertical: localVertical, mirrorHorizontal: false },
    isInlineEditing: editing,
    elements,
    REFERENCE_STAGE_WIDTH: 1000,
    window: { innerHeight: 600, CSS: { supports: () => true } },
    document: { documentElement: { style: { setProperty: (key, value) => { properties[key] = value; } } } },
    $: () => control(),
    updateMirrorPermissions() {},
    unifiedLines: () => Array.from({ length: 15 }, (_, index) => String(index)),
    getComputedStyle: () => ({ lineHeight: "120px", paddingTop: properties["--prompt-padding-top"] })
  });
  vm.runInContext(functions, context);
  context.updateMirror();
  return { context, elements, properties };
}

for (const vertical of [false, true]) {
  for (const reverse of [false, true]) {
    test(`镜像=${vertical}，滚动翻转=${reverse}：移动方向、定位线及锚点一致`, () => {
      const { context, elements, properties } = fixture({ vertical, reverse });
      assert.equal(elements.stage.style.transform, `scaleY(${vertical ? -1 : 1})`);
      assert.equal(elements.promptContent.style.transform, "scaleX(1)");
      const velocity = context.scrollVelocity();
      const visibleVelocity = -velocity * (vertical ? -1 : 1);
      assert.equal(Math.sign(visibleVelocity), vertical !== reverse ? 1 : -1);
      const metrics = context.getLayoutMetrics();
      assert.equal(metrics.guideY, vertical ? 420 : 180);
      assert.equal(properties["--prompt-padding-top"], `${metrics.guideY}px`);
      assert.equal(Number.parseFloat(properties["--prompt-padding-bottom"]) + metrics.guideY, 600);
      const anchor = context.getLineAnchor();
      assert.equal(context.scrollTopForAnchor(anchor), 360);
      elements.stage.scrollTop += velocity;
      assert.ok(context.getLineAnchor() > anchor, "正放和倒置都应按文稿顺序前进");
      elements.stage.scrollTop = context.startScrollTop();
      assert.equal(context.getLineAnchor(), 0);
    });
  }
}

test("本机镜像与跟随房间切换保留当前阅读锚点", () => {
  const { context, elements } = fixture({ vertical: true, follow: false });
  const anchor = context.getLineAnchor();
  assert.equal(elements.stage.style.transform, "scaleY(1)");
  context.localView.mirrorVertical = true;
  context.updateMirror();
  assert.equal(elements.stage.style.transform, "scaleY(-1)");
  assert.equal(context.getLineAnchor(), anchor);
  context.localView.followRoomMirror = true;
  context.state.mirrorVertical = false;
  context.updateMirror();
  assert.equal(elements.stage.style.transform, "scaleY(1)");
  assert.equal(context.getLineAnchor(), anchor);
});

test("左右与上下镜像可叠加，原位编辑取消两种镜像，退出后恢复", () => {
  const { context, elements } = fixture({ vertical: true, horizontal: true });
  assert.equal(elements.promptContent.style.transform, "scaleX(-1)");
  assert.equal(elements.stage.style.transform, "scaleY(-1)");
  context.isInlineEditing = true;
  context.updateMirror();
  assert.equal(elements.promptContent.style.transform, "scaleX(1)");
  assert.equal(elements.stage.style.transform, "scaleY(1)");
  context.isInlineEditing = false;
  context.updateMirror();
  assert.equal(elements.promptContent.style.transform, "scaleX(-1)");
  assert.equal(elements.stage.style.transform, "scaleY(-1)");
});
