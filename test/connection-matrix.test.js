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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("测试服务启动超时");
}

class Client {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type && waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else this.messages.push(message);
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  send(type, payload = {}) {
    this.ws.send(JSON.stringify({ type, payload }));
  }

  next(type, predicate = () => true, timeout = 2000) {
    const index = this.messages.findIndex((message) => message.type === type && predicate(message));
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`等待消息 ${type} 超时`));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close() {
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) this.ws.close();
  }
}

async function createHarness(context, options = {}) {
  const port = await freePort();
  const dataFile = `/tmp/cueweave-matrix-${process.pid}-${port}.json`;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      OWNER_GRACE_MS: String(options.ownerGraceMs ?? 120),
      EMPTY_ROOM_TTL_MS: String(options.emptyRoomTtlMs ?? 60_000),
      ROOM_DATA_FILE: dataFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const clients = [];
  context.after(() => {
    clients.forEach((client) => client.close());
    child.kill("SIGTERM");
  });
  await waitForServer(port);
  return {
    port,
    child,
    async client() {
      const client = new Client(`ws://127.0.0.1:${port}/ws`);
      clients.push(client);
      await client.open();
      return client;
    }
  };
}

async function createRoom(owner, mode = "restricted", deviceMode = "control") {
  owner.send("room.create", {
    name: "房主",
    deviceMode,
    roomMode: mode,
    state: { script: "连接矩阵", fontSize: 58, scrollSpeed: 45 },
    playback: { playing: false, progress: 0, speed: 45, extent: 1000 }
  });
  return (await owner.next("room.created")).payload;
}

async function join(client, roomId, deviceMode, name = deviceMode) {
  client.send("room.join", { roomId, name, deviceMode });
  return (await client.next("room.joined")).payload;
}

test("三种房间模式与四种设备用途执行正确权限矩阵", async (context) => {
  const harness = await createHarness(context);

  const openOwner = await harness.client();
  const openRoom = await createRoom(openOwner, "open");
  const openControl = await harness.client();
  const openControlJoin = await join(openControl, openRoom.roomId, "control");
  assert.deepEqual(openControlJoin.permissions, {
    editScript: true, editAppearance: true, controlPlayback: true, controlProgress: true, manageRoom: false
  });
  const openDisplay = await harness.client();
  const openDisplayJoin = await join(openDisplay, openRoom.roomId, "display");
  assert.deepEqual(openDisplayJoin.permissions, {
    editScript: false, editAppearance: false, controlPlayback: false, controlProgress: false, manageRoom: false
  });
  openDisplay.send("playback.update", { action: "play", playing: true, progress: 0, speed: 45 });
  assert.equal((await openDisplay.next("error")).payload.code, "FORBIDDEN");

  const restrictedOwner = await harness.client();
  const restrictedRoom = await createRoom(restrictedOwner, "restricted");
  const editor = await harness.client();
  const editorJoin = await join(editor, restrictedRoom.roomId, "editor");
  assert.equal(editorJoin.self.role, "viewer");
  restrictedOwner.send("member.update", { deviceId: editorJoin.self.deviceId, role: "editor" });
  const editorPermissions = (await editor.next("members.updated", (message) => message.payload.permissions.editScript)).payload.permissions;
  assert.equal(editorPermissions.editScript, true);
  assert.equal(editorPermissions.editAppearance, true);
  assert.equal(editorPermissions.controlPlayback, false);

  const operator = await harness.client();
  const operatorJoin = await join(operator, restrictedRoom.roomId, "director");
  restrictedOwner.send("member.update", { deviceId: operatorJoin.self.deviceId, role: "operator" });
  const operatorPermissions = (await operator.next("members.updated", (message) => message.payload.permissions.controlPlayback)).payload.permissions;
  assert.equal(operatorPermissions.editScript, false);
  assert.equal(operatorPermissions.controlPlayback, true);
  assert.equal(operatorPermissions.controlProgress, true);
  operator.send("playback.update", { action: "play", playing: true, progress: 0.1, speed: 30, extent: 900 });
  assert.equal((await restrictedOwner.next("playback.updated")).payload.speed, 30);

  restrictedOwner.send("room.mode", { mode: "director" });
  const directorEditor = await editor.next("members.updated", (message) => message.payload.mode === "director");
  assert.equal(directorEditor.payload.permissions.editScript, true);
  assert.equal(directorEditor.payload.permissions.editAppearance, false);
  editor.send("state.patch", { patch: { script: "允许的改稿", fontSize: 80 } });
  assert.equal((await editor.next("error")).payload.code, "FORBIDDEN");
});

test("房主宽限期重连、超时移交、手动移交与关闭房间均正常", async (context) => {
  const harness = await createHarness(context, { ownerGraceMs: 160 });
  const owner = await harness.client();
  const room = await createRoom(owner, "restricted", "display");
  assert.equal(room.self.deviceMode, "control", "创建房间的房主不能成为纯显示端");

  const editor = await harness.client();
  const editorJoin = await join(editor, room.roomId, "editor", "候选编辑者");
  owner.send("member.update", { deviceId: editorJoin.self.deviceId, role: "editor" });
  await editor.next("members.updated", (message) => message.payload.permissions.editScript);

  const display = await harness.client();
  const displayJoin = await join(display, room.roomId, "display", "显示屏");
  owner.send("owner.transfer", { deviceId: displayJoin.self.deviceId });
  assert.equal((await owner.next("error")).payload.code, "INVALID_OWNER");
  owner.send("member.update", { deviceId: room.self.deviceId, deviceMode: "display" });
  assert.equal((await owner.next("error")).payload.code, "INVALID_OWNER_MODE");

  owner.close();
  await editor.next("owner.changed", (message) => message.payload.newOwnerId === editorJoin.self.deviceId, 1500);
  const promoted = await editor.next("members.updated", (message) => message.payload.self.role === "owner");
  assert.equal(promoted.payload.permissions.manageRoom, true);

  const returnedOwner = await harness.client();
  returnedOwner.send("room.join", {
    roomId: room.roomId,
    deviceId: room.self.deviceId,
    reconnectToken: room.reconnectToken,
    name: "原房主"
  });
  const returned = (await returnedOwner.next("room.joined")).payload;
  assert.equal(returned.self.role, "editor", "移交后原房主不能自动抢回房主身份");

  editor.send("owner.transfer", { deviceId: returned.self.deviceId });
  await returnedOwner.next("owner.changed", (message) => message.payload.newOwnerId === returned.self.deviceId);
  const manuallyPromoted = await returnedOwner.next("members.updated", (message) => message.payload.self.role === "owner");
  assert.equal(manuallyPromoted.payload.permissions.manageRoom, true);

  returnedOwner.send("room.close");
  await display.next("room.closed");
  const late = await harness.client();
  late.send("room.join", { roomId: room.roomId, name: "迟到设备", deviceMode: "control" });
  assert.equal((await late.next("error")).payload.code, "ROOM_NOT_FOUND");
});

test("房主在宽限期内重连会保留身份且不会触发移交", async (context) => {
  const harness = await createHarness(context, { ownerGraceMs: 300 });
  const owner = await harness.client();
  const room = await createRoom(owner);
  const guest = await harness.client();
  await join(guest, room.roomId, "control", "等待设备");
  owner.close();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const resumed = await harness.client();
  resumed.send("room.join", {
    roomId: room.roomId,
    deviceId: room.self.deviceId,
    reconnectToken: room.reconnectToken,
    name: "重连房主"
  });
  const joined = (await resumed.next("room.joined")).payload;
  assert.equal(joined.self.role, "owner");
  await new Promise((resolve) => setTimeout(resolve, 360));
  resumed.send("room.resync");
  assert.equal((await resumed.next("room.snapshot")).payload.self.role, "owner");
});

test("输入校验、边界钳制、未知消息和超大消息受到保护", async (context) => {
  const harness = await createHarness(context);
  const owner = await harness.client();
  const room = await createRoom(owner, "open");

  owner.send("state.patch", {
    patch: {
      script: "边界更新",
      fontSize: 999,
      lineHeight: -5,
      scrollSpeed: 0,
      backgroundColor: "javascript:bad",
      unexpected: "ignored"
    }
  });
  owner.send("room.resync");
  const snapshot = (await owner.next("room.snapshot")).payload;
  assert.equal(snapshot.state.script, "边界更新");
  assert.equal(snapshot.state.fontSize, 120);
  assert.equal(snapshot.state.lineHeight, 1);
  assert.equal(snapshot.state.scrollSpeed, 5);
  assert.equal(snapshot.state.backgroundColor, undefined);
  assert.equal(snapshot.state.unexpected, undefined);

  owner.send("unknown.event", {});
  assert.equal((await owner.next("error")).payload.code, "UNKNOWN_MESSAGE");

  const huge = await harness.client();
  const closeCode = new Promise((resolve) => huge.ws.once("close", resolve));
  huge.ws.send(JSON.stringify({ type: "room.join", payload: { roomId: room.roomId, name: "x".repeat(300_000) } }));
  assert.equal(await closeCode, 1009);
});

test("空房间按TTL销毁，服务重启会通知客户端并及时退出", async (context) => {
  const expiringHarness = await createHarness(context, { emptyRoomTtlMs: 100 });
  const expiringOwner = await expiringHarness.client();
  const expiringRoom = await createRoom(expiringOwner);
  expiringOwner.close();
  await new Promise((resolve) => setTimeout(resolve, 260));
  const late = await expiringHarness.client();
  late.send("room.join", { roomId: expiringRoom.roomId, name: "过期后加入", deviceMode: "control" });
  assert.equal((await late.next("error")).payload.code, "ROOM_NOT_FOUND");

  const shutdownHarness = await createHarness(context);
  const connected = await shutdownHarness.client();
  await createRoom(connected);
  const closeCode = new Promise((resolve) => connected.ws.once("close", resolve));
  const exited = new Promise((resolve) => shutdownHarness.child.once("exit", resolve));
  shutdownHarness.child.kill("SIGTERM");
  assert.equal(await closeCode, 1012);
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("服务未在期限内退出")), 2000))
  ]);
});

test("同一设备的新连接会接管身份并以明确关闭码停止旧连接", async (context) => {
  const harness = await createHarness(context);
  const first = await harness.client();
  const room = await createRoom(first);
  const oldConnectionClosed = new Promise((resolve) => first.ws.once("close", resolve));
  const replacement = await harness.client();
  replacement.send("room.join", {
    roomId: room.roomId,
    deviceId: room.self.deviceId,
    reconnectToken: room.reconnectToken,
    name: "同设备新标签"
  });
  const resumed = (await replacement.next("room.joined")).payload;
  assert.equal(resumed.self.role, "owner");
  assert.equal(await oldConnectionClosed, 4001);
  replacement.send("room.resync");
  assert.equal((await replacement.next("room.snapshot")).payload.self.role, "owner");
});
