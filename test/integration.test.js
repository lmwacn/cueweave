import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { WebSocket } from "ws";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试服务启动超时");
}

class TestClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type && waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else this.messages.push(message);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  next(type, predicate = () => true, timeout = 2000) {
    const existingIndex = this.messages.findIndex((message) => message.type === type && predicate(message));
    if (existingIndex >= 0) return Promise.resolve(this.messages.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`等待消息 ${type} 超时`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    this.ws.close();
  }
}

test("多设备房间支持权限控制、状态同步和播放同步", async (context) => {
  const port = await freePort();
  const dataFile = `/tmp/cueweave-test-${process.pid}-${port}.json`;
  const dataDir = `${dataFile}.rooms-v4`;
  let processHandle = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), OWNER_GRACE_MS: "200", ROOM_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  context.after(() => processHandle.kill("SIGTERM"));
  await waitForServer(port);
  const info = await (await fetch(`http://127.0.0.1:${port}/api/info`)).json();
  assert.equal(info.port, port);
  assert.ok(Array.isArray(info.origins));
  const qrResponse = await fetch(`http://127.0.0.1:${port}/api/qr?data=${encodeURIComponent(`http://127.0.0.1:${port}/room/ABCDEF?mode=display`)}`);
  assert.equal(qrResponse.status, 200);
  assert.match(qrResponse.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await qrResponse.text(), /<svg/);
  const roomRoute = await fetch(`http://127.0.0.1:${port}/room/ABCDEF`);
  assert.equal(roomRoute.status, 200);
  assert.match(roomRoute.headers.get("content-type"), /text\/html/);
  assert.match(roomRoute.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(roomRoute.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await fetch(`http://127.0.0.1:${port}/room/INVALID`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/server.js`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/data/rooms.json`)).status, 404);

  const rejectedOrigin = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://malicious.example" });
  const rejectedStatus = await new Promise((resolve) => rejectedOrigin.once("unexpected-response", (_request, response) => resolve(response.statusCode)));
  assert.equal(rejectedStatus, 403);

  const defaultPortOrigin = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: "https://cueweave.example",
    headers: { host: "cueweave.example:443" }
  });
  await new Promise((resolve, reject) => {
    defaultPortOrigin.once("open", resolve);
    defaultPortOrigin.once("error", reject);
  });
  defaultPortOrigin.close();

  const owner = new TestClient(`ws://127.0.0.1:${port}/ws`);
  const guest = new TestClient(`ws://127.0.0.1:${port}/ws`);
  context.after(() => { owner.close(); guest.close(); });
  await Promise.all([owner.open(), guest.open()]);

  owner.send("room.create", {
    name: "主控电脑",
    deviceMode: "control",
    roomMode: "restricted",
    state: { script: "初始文稿", fontSize: 58, scrollSpeed: 45 },
    playback: { playing: false, progress: 0, speed: 45 }
  });
  const created = await owner.next("room.created");
  assert.equal(created.payload.self.role, "owner");
  assert.equal(created.payload.state.script, "初始文稿");

  guest.send("room.join", { roomId: created.payload.roomId, name: "文案平板", deviceMode: "editor" });
  const joined = await guest.next("room.joined");
  assert.equal(joined.payload.self.role, "viewer");
  assert.equal(joined.payload.permissions.editScript, false);

  guest.send("state.patch", { patch: { script: "越权修改" }, baseScriptRevision: joined.payload.scriptRevision });
  const forbidden = await guest.next("error");
  assert.equal(forbidden.payload.code, "FORBIDDEN");
  assert.equal(forbidden.payload.snapshot.state.script, "初始文稿");

  owner.send("member.update", { deviceId: joined.payload.self.deviceId, role: "editor" });
  const authorized = await guest.next("members.updated", (message) => message.payload.permissions.editScript === true);
  assert.equal(authorized.payload.permissions.editAppearance, true);

  guest.send("state.patch", { patch: { script: "授权后的文稿" }, baseScriptRevision: joined.payload.scriptRevision });
  const stateUpdate = await owner.next("state.patch");
  assert.equal(stateUpdate.payload.patch.script, "授权后的文稿");

  owner.send("room.mode", { mode: "director" });
  const directorMode = await guest.next("members.updated", (message) => message.payload.mode === "director");
  assert.equal(directorMode.payload.permissions.editScript, true);
  assert.equal(directorMode.payload.permissions.editAppearance, false);
  guest.send("state.patch", { patch: { fontSize: 80 } });
  assert.equal((await guest.next("error")).payload.code, "FORBIDDEN");

  owner.send("playback.update", { action: "play", playing: true, progress: 0.25, anchor: 12.5, speed: 52, extent: 2400 });
  const playback = await guest.next("playback.updated");
  assert.equal(playback.payload.playing, true);
  assert.equal(playback.payload.progress, 0.25);
  assert.equal(playback.payload.anchor, 12.5);
  assert.equal(playback.payload.speed, 52);
  assert.equal(playback.payload.extent, 2400);
  assert.equal(playback.payload.sourceDeviceId, created.payload.self.deviceId);

  owner.send("playback.update", { action: "scrub", playing: true, progress: 0.4, anchor: 18.25, speed: 52, extent: 2400 });
  const scrub = await guest.next("playback.updated");
  assert.equal(scrub.payload.action, "scrub");
  assert.equal(scrub.payload.playing, true);
  assert.equal(scrub.payload.progress, 0.4);
  assert.equal(scrub.payload.anchor, 18.25);

  owner.close();
  guest.close();
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => processHandle.once("exit", resolve));
  processHandle = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), OWNER_GRACE_MS: "200", ROOM_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForServer(port);
  const resumedOwner = new TestClient(`ws://127.0.0.1:${port}/ws`);
  context.after(() => resumedOwner.close());
  await resumedOwner.open();
  resumedOwner.send("room.join", {
    roomId: created.payload.roomId,
    deviceId: created.payload.self.deviceId,
    reconnectToken: created.payload.reconnectToken,
    name: "主控电脑"
  });
  const resumed = await resumedOwner.next("room.joined");
  assert.equal(resumed.payload.self.role, "owner");
  assert.equal(resumed.payload.state.script, "授权后的文稿");
  assert.equal(resumed.payload.playback.playing, false);
});
