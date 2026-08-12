import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import QRCode from "qrcode";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 17321);
const HOST = process.env.HOST || "0.0.0.0";
const OWNER_GRACE_MS = Number(process.env.OWNER_GRACE_MS || 60_000);
// 0 表示永久保留空房间；只有显式配置正数时才会自动过期。
const EMPTY_ROOM_TTL_MS = Math.max(0, Number(process.env.EMPTY_ROOM_TTL_MS || 0) || 0);
const MAX_MESSAGE_BYTES = 256 * 1024;
const DATA_FILE = process.env.ROOM_DATA_FILE || resolve(ROOT, "data/rooms.json");
const rooms = new Map();
let persistTimer = null;
let persistChain = Promise.resolve();
const publicFiles = new Set(["/index.html", "/app.js", "/sync-client.js", "/styles.css"]);

const stateKeys = new Set([
  "script", "fontSize", "lineHeight", "letterSpacing", "contentWidth",
  "backgroundColor", "textColor", "guideColor", "guidePosition", "showGuide",
  "mirrorHorizontal", "mirrorVertical", "scrollSpeed"
]);
const numericRanges = {
  fontSize: [24, 120], lineHeight: [1, 2.5], letterSpacing: [-2, 20],
  contentWidth: [40, 100], guidePosition: [15, 85], scrollSpeed: [5, 180]
};
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function token(bytes = 18) {
  return randomBytes(bytes).toString("base64url");
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) code += alphabet[randomBytes(1)[0] % alphabet.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("无法生成房间码");
}

function cleanName(value) {
  const name = String(value || "未命名设备").trim().slice(0, 30);
  return name || "未命名设备";
}

function cleanDeviceMode(value) {
  return ["control", "editor", "director", "display"].includes(value) ? value : "control";
}

function cleanRoomMode(value) {
  return ["open", "restricted", "director"].includes(value) ? value : "restricted";
}

function cleanRole(value) {
  return ["editor", "operator", "viewer"].includes(value) ? value : "viewer";
}

function localOrigins(request) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  const requestHost = String(request.headers.host || `localhost:${PORT}`);
  const port = requestHost.includes(":") ? requestHost.slice(requestHost.lastIndexOf(":")) : (PORT === 80 || PORT === 443 ? "" : `:${PORT}`);
  const origins = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) origins.push(`${protocol}://${address.address}${port}`);
    }
  }
  origins.push(`${protocol}://${requestHost}`);
  return [...new Set(origins)];
}

function cleanState(input = {}, partial = false) {
  const output = {};
  for (const key of stateKeys) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === "script") output[key] = String(value).slice(0, 100_000);
    else if (["backgroundColor", "textColor", "guideColor"].includes(key)) {
      if (/^#[0-9a-f]{6}$/i.test(String(value))) output[key] = String(value);
    } else if (["showGuide", "mirrorHorizontal", "mirrorVertical"].includes(key)) output[key] = Boolean(value);
    else if (Number.isFinite(Number(value))) {
      const [minimum, maximum] = numericRanges[key] || [-Number.MAX_VALUE, Number.MAX_VALUE];
      output[key] = Math.min(maximum, Math.max(minimum, Number(value)));
    }
  }
  if (!partial && !("script" in output)) output.script = "";
  return output;
}

function cleanPlayback(input = {}) {
  const playback = {
    playing: Boolean(input.playing),
    progress: Math.min(1, Math.max(0, Number(input.progress) || 0)),
    speed: Math.min(180, Math.max(5, Number(input.speed) || 45)),
    extent: Math.max(0, Number(input.extent) || 0),
    updatedAt: Date.now()
  };
  if (Number.isFinite(Number(input.anchor))) playback.anchor = Math.min(100_000, Math.max(-10_000, Number(input.anchor)));
  return playback;
}

function permissions(room, member) {
  const none = { editScript: false, editAppearance: false, controlPlayback: false, controlProgress: false, manageRoom: false };
  if (!member) return none;
  if (member.role === "owner") return { editScript: true, editAppearance: true, controlPlayback: true, controlProgress: true, manageRoom: true };
  if (member.deviceMode === "display") return none;
  if (room.mode === "open") return { editScript: true, editAppearance: true, controlPlayback: true, controlProgress: true, manageRoom: false };
  if (member.role === "editor") return { ...none, editScript: true, editAppearance: room.mode !== "director" };
  if (member.role === "operator") return { ...none, controlPlayback: true, controlProgress: true };
  return none;
}

function publicMember(member) {
  return {
    deviceId: member.deviceId,
    name: member.name,
    role: member.role,
    deviceMode: member.deviceMode,
    connected: member.connected,
    joinedAt: member.joinedAt
  };
}

function send(ws, type, payload = {}) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, payload, serverTime: Date.now() }));
}

function broadcast(room, type, payload = {}, except = null) {
  for (const member of room.members.values()) {
    if (member.socket && member.socket !== except) send(member.socket, type, payload);
  }
}

function roomSnapshot(room, member) {
  return {
    roomId: room.id,
    mode: room.mode,
    revision: room.revision,
    state: room.state,
    playback: room.playback,
    self: publicMember(member),
    permissions: permissions(room, member),
    members: [...room.members.values()].map(publicMember),
    ownerGraceMs: OWNER_GRACE_MS
  };
}

function broadcastMembers(room) {
  const members = [...room.members.values()].map(publicMember);
  for (const member of room.members.values()) {
    if (member.socket) send(member.socket, "members.updated", {
      members,
      self: publicMember(member),
      mode: room.mode,
      permissions: permissions(room, member)
    });
  }
  schedulePersist();
}

function serializedRooms() {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    mode: room.mode,
    ownerId: room.ownerId,
    revision: room.revision,
    state: room.state,
    playback: room.playback,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt || room.createdAt,
    members: [...room.members.values()].map((member) => ({
      deviceId: member.deviceId,
      reconnectToken: member.reconnectToken,
      name: member.name,
      role: member.role,
      deviceMode: member.deviceMode,
      joinedAt: member.joinedAt
    }))
  }));
}

function persistRooms() {
  clearTimeout(persistTimer);
  persistTimer = null;
  const content = JSON.stringify({ version: 1, rooms: serializedRooms() }, null, 2);
  persistChain = persistChain.catch(() => {}).then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await writeFile(temporaryFile, content, "utf8");
    await rename(temporaryFile, DATA_FILE);
  });
  return persistChain;
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistRooms().catch((error) => console.error("保存房间数据失败：", error.message)), 150);
}

async function loadRooms() {
  try {
    const stored = JSON.parse(await readFile(DATA_FILE, "utf8"));
    const now = Date.now();
    for (const data of stored.rooms || []) {
      if (EMPTY_ROOM_TTL_MS > 0 && now - Number(data.lastActiveAt || data.createdAt) > EMPTY_ROOM_TTL_MS) continue;
      const members = new Map((data.members || []).map((member) => [member.deviceId, {
        ...member,
        connected: false,
        disconnectedAt: now,
        socket: null
      }]));
      if (!members.size) continue;
      const room = {
        id: data.id,
        mode: cleanRoomMode(data.mode),
        ownerId: data.ownerId,
        revision: Number(data.revision) || 1,
        state: cleanState(data.state),
        playback: { ...cleanPlayback(data.playback), playing: false },
        members,
        createdAt: Number(data.createdAt) || now,
        lastActiveAt: Number(data.lastActiveAt) || now,
        ownerTimer: null,
        emptyTimer: null
      };
      rooms.set(room.id, room);
      if (EMPTY_ROOM_TTL_MS > 0) {
        const remaining = Math.max(1, EMPTY_ROOM_TTL_MS - (now - room.lastActiveAt));
        room.emptyTimer = setTimeout(() => { rooms.delete(room.id); schedulePersist(); }, remaining);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("读取房间数据失败：", error.message);
  }
}

function initialRole(roomMode, deviceMode) {
  if (deviceMode === "display") return "viewer";
  if (roomMode === "open") return deviceMode === "director" ? "operator" : "editor";
  return "viewer";
}

function requirePermission(ws, key) {
  const room = rooms.get(ws.context?.roomId);
  const member = room?.members.get(ws.context?.deviceId);
  if (!room || !member) {
    send(ws, "error", { code: "NOT_IN_ROOM", message: "请先加入房间" });
    return null;
  }
  if (!permissions(room, member)[key]) {
    send(ws, "error", { code: "FORBIDDEN", message: "当前设备没有执行此操作的权限", snapshot: roomSnapshot(room, member) });
    return null;
  }
  return { room, member };
}

function clearRoomTimers(room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
}

function scheduleEmptyRoom(room) {
  clearRoomTimers(room);
  if ([...room.members.values()].some((member) => member.connected)) return;
  room.lastActiveAt = Date.now();
  if (EMPTY_ROOM_TTL_MS > 0) {
    room.emptyTimer = setTimeout(() => { rooms.delete(room.id); schedulePersist(); }, EMPTY_ROOM_TTL_MS);
  }
  schedulePersist();
}

function electOwner(room, previousOwnerId) {
  const candidates = [...room.members.values()]
    .filter((member) => member.connected && member.deviceMode !== "display" && member.deviceId !== previousOwnerId)
    .sort((a, b) => {
      const rank = { editor: 0, operator: 1, viewer: 2 };
      return (rank[a.role] ?? 3) - (rank[b.role] ?? 3) || a.joinedAt - b.joinedAt;
    });
  const next = candidates[0];
  if (!next) return;
  const previous = room.members.get(previousOwnerId);
  if (previous?.role === "owner") previous.role = "editor";
  next.role = "owner";
  room.ownerId = next.deviceId;
  room.revision += 1;
  room.lastActiveAt = Date.now();
  broadcast(room, "owner.changed", { previousOwnerId, newOwnerId: next.deviceId, reason: "owner_timeout" });
  broadcastMembers(room);
}

function scheduleOwnerElection(room, ownerId) {
  if (room.ownerTimer) clearTimeout(room.ownerTimer);
  room.ownerTimer = setTimeout(() => {
    const owner = room.members.get(ownerId);
    if (owner?.connected || room.ownerId !== ownerId) return;
    electOwner(room, ownerId);
  }, OWNER_GRACE_MS);
}

function attachMember(ws, room, member) {
  if (member.socket && member.socket !== ws) member.socket.close(4001, "设备已在其他连接登录");
  member.socket = ws;
  member.connected = true;
  member.disconnectedAt = null;
  ws.context = { roomId: room.id, deviceId: member.deviceId };
  clearRoomTimers(room);
  if (member.deviceId === room.ownerId && room.ownerTimer) {
    clearTimeout(room.ownerTimer);
    room.ownerTimer = null;
  }
}

function handleCreate(ws, payload) {
  if (ws.context) return send(ws, "error", { code: "ALREADY_IN_ROOM", message: "当前连接已经加入房间" });
  const id = roomCode();
  const deviceId = String(payload.deviceId || token(12)).slice(0, 80);
  const member = {
    deviceId,
    reconnectToken: token(),
    name: cleanName(payload.name),
    role: "owner",
    deviceMode: cleanDeviceMode(payload.deviceMode) === "display" ? "control" : cleanDeviceMode(payload.deviceMode),
    connected: true,
    joinedAt: Date.now(),
    socket: ws
  };
  const room = {
    id,
    mode: cleanRoomMode(payload.roomMode),
    ownerId: deviceId,
    revision: 1,
    state: cleanState(payload.state),
    playback: { ...cleanPlayback(payload.playback), sourceDeviceId: deviceId },
    members: new Map([[deviceId, member]]),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    ownerTimer: null,
    emptyTimer: null
  };
  rooms.set(id, room);
  attachMember(ws, room, member);
  send(ws, "room.created", { ...roomSnapshot(room, member), reconnectToken: member.reconnectToken });
  schedulePersist();
}

function handleJoin(ws, payload) {
  if (ws.context) return send(ws, "error", { code: "ALREADY_IN_ROOM", message: "当前连接已经加入房间" });
  const room = rooms.get(String(payload.roomId || "").trim().toUpperCase());
  if (!room) return send(ws, "error", { code: "ROOM_NOT_FOUND", message: "房间不存在或已经过期" });

  const requestedId = String(payload.deviceId || "").slice(0, 80);
  let member = room.members.get(requestedId);
  if (member && payload.reconnectToken === member.reconnectToken) {
    member.name = cleanName(payload.name || member.name);
  } else {
    const deviceId = token(12);
    const deviceMode = cleanDeviceMode(payload.deviceMode);
    member = {
      deviceId,
      reconnectToken: token(),
      name: cleanName(payload.name),
      role: initialRole(room.mode, deviceMode),
      deviceMode,
      connected: true,
      joinedAt: Date.now(),
      socket: ws
    };
    room.members.set(deviceId, member);
  }
  attachMember(ws, room, member);
  room.lastActiveAt = Date.now();
  if (member.deviceId !== room.ownerId && !room.members.get(room.ownerId)?.connected) scheduleOwnerElection(room, room.ownerId);
  send(ws, "room.joined", { ...roomSnapshot(room, member), reconnectToken: member.reconnectToken });
  broadcastMembers(room);
}

function handleStatePatch(ws, payload) {
  const patchKeys = Object.keys(payload.patch || {});
  const includesScript = patchKeys.includes("script");
  const includesAppearance = patchKeys.some((key) => key !== "script");
  const context = requirePermission(ws, includesScript ? "editScript" : "editAppearance");
  if (!context) return;
  if (includesAppearance && !permissions(context.room, context.member).editAppearance) {
    return send(ws, "error", { code: "FORBIDDEN", message: "当前设备没有修改画面设置的权限", snapshot: roomSnapshot(context.room, context.member) });
  }
  const patch = cleanState(payload.patch, true);
  if (!Object.keys(patch).length) return;
  context.room.state = { ...context.room.state, ...patch };
  context.room.revision += 1;
  context.room.lastActiveAt = Date.now();
  broadcast(context.room, "state.patch", { patch, revision: context.room.revision, sourceDeviceId: context.member.deviceId }, ws);
  schedulePersist();
}

function handlePlayback(ws, payload) {
  const action = ["play", "pause", "seek", "scrub", "sync", "top"].includes(payload.action) ? payload.action : "sync";
  const context = requirePermission(ws, action === "seek" || action === "scrub" || action === "sync" || action === "top" ? "controlProgress" : "controlPlayback");
  if (!context) return;
  const next = cleanPlayback({
    playing: action === "play" ? true : action === "pause" || action === "top" ? false : payload.playing,
    progress: action === "top" ? 0 : payload.progress,
    anchor: action === "top" ? undefined : payload.anchor,
    speed: payload.speed,
    extent: payload.extent
  });
  next.sourceDeviceId = context.member.deviceId;
  context.room.playback = next;
  context.room.revision += 1;
  context.room.lastActiveAt = Date.now();
  broadcast(context.room, "playback.updated", { ...next, action, revision: context.room.revision, sourceDeviceId: context.member.deviceId }, ws);
  schedulePersist();
}

function handleRoomMode(ws, payload) {
  const context = requirePermission(ws, "manageRoom");
  if (!context) return;
  context.room.mode = cleanRoomMode(payload.mode);
  context.room.revision += 1;
  context.room.lastActiveAt = Date.now();
  broadcastMembers(context.room);
}

function handleMemberUpdate(ws, payload) {
  const context = requirePermission(ws, "manageRoom");
  if (!context) return;
  const target = context.room.members.get(String(payload.deviceId));
  if (!target) return send(ws, "error", { code: "MEMBER_NOT_FOUND", message: "设备不在线或不存在" });
  if (target.role === "owner" && target.deviceId !== context.member.deviceId) return;
  if ("role" in payload && target.role !== "owner") target.role = cleanRole(payload.role);
  if ("deviceMode" in payload) {
    const nextMode = cleanDeviceMode(payload.deviceMode);
    if (target.role === "owner" && nextMode === "display") return send(ws, "error", { code: "INVALID_OWNER_MODE", message: "房主设备不能设为显示端，请先移交房主" });
    target.deviceMode = nextMode;
  }
  context.room.revision += 1;
  context.room.lastActiveAt = Date.now();
  broadcastMembers(context.room);
}

function handleTransferOwner(ws, payload) {
  const context = requirePermission(ws, "manageRoom");
  if (!context) return;
  const target = context.room.members.get(String(payload.deviceId));
  if (!target?.connected || target.deviceMode === "display") return send(ws, "error", { code: "INVALID_OWNER", message: "只能将房主移交给在线的非显示设备" });
  context.member.role = "editor";
  target.role = "owner";
  context.room.ownerId = target.deviceId;
  context.room.revision += 1;
  context.room.lastActiveAt = Date.now();
  broadcast(context.room, "owner.changed", { previousOwnerId: context.member.deviceId, newOwnerId: target.deviceId, reason: "manual" });
  broadcastMembers(context.room);
}

function handleCloseRoom(ws) {
  const context = requirePermission(ws, "manageRoom");
  if (!context) return;
  broadcast(context.room, "room.closed", { message: "房主已关闭房间" });
  for (const member of context.room.members.values()) member.socket?.close(4000, "房间已关闭");
  rooms.delete(context.room.id);
  schedulePersist();
}

function handleMessage(ws, raw) {
  if (raw.length > MAX_MESSAGE_BYTES) return ws.close(1009, "消息过大");
  const now = Date.now();
  if (!ws.rateWindowAt || now - ws.rateWindowAt > 10_000) {
    ws.rateWindowAt = now;
    ws.rateCount = 0;
  }
  ws.rateCount += 1;
  if (ws.rateCount > 250) return ws.close(1008, "消息发送过于频繁");
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { return send(ws, "error", { code: "INVALID_JSON", message: "消息格式错误" }); }
  const payload = message.payload || {};
  const handlers = {
    "room.create": handleCreate,
    "room.join": handleJoin,
    "room.resync": (socket) => {
      const room = rooms.get(socket.context?.roomId);
      const member = room?.members.get(socket.context?.deviceId);
      if (room && member) send(socket, "room.snapshot", roomSnapshot(room, member));
    },
    "state.patch": handleStatePatch,
    "playback.update": handlePlayback,
    "room.mode": handleRoomMode,
    "member.update": handleMemberUpdate,
    "owner.transfer": handleTransferOwner,
    "room.close": handleCloseRoom
  };
  const handler = handlers[message.type];
  if (!handler) return send(ws, "error", { code: "UNKNOWN_MESSAGE", message: "不支持的消息类型" });
  handler(ws, payload);
}

function handleDisconnect(ws) {
  const room = rooms.get(ws.context?.roomId);
  const member = room?.members.get(ws.context?.deviceId);
  if (!room || !member || member.socket !== ws) return;
  member.socket = null;
  member.connected = false;
  member.disconnectedAt = Date.now();
  broadcastMembers(room);
  if (member.deviceId === room.ownerId) scheduleOwnerElection(room, member.deviceId);
  scheduleEmptyRoom(room);
}

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
      return;
    }
    if (pathname === "/api/info") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ origins: localOrigins(request), port: PORT }));
      return;
    }
    if (pathname === "/api/qr") {
      const data = url.searchParams.get("data") || "";
      if (!data || data.length > 2048) throw Object.assign(new Error("Bad request"), { statusCode: 400 });
      const svg = await QRCode.toString(data, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 2,
        color: { dark: "#11151d", light: "#ffffff" }
      });
      response.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "private, max-age=300",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"
      });
      response.end(svg);
      return;
    }
    if (pathname === "/" || /^\/room\/[A-Z2-9]{6}\/?$/i.test(pathname)) pathname = "/index.html";
    if (!publicFiles.has(pathname)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
    const filePath = resolve(ROOT, `.${normalize(pathname)}`);
    if (!filePath.startsWith(`${ROOT}${sep}`)) throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    const info = await stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error("Not found"), { statusCode: 404 });
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": [".html", ".js", ".css"].includes(extname(filePath)) ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN"
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error.statusCode || 404, { "content-type": "text/plain; charset=utf-8" });
    response.end(error.statusCode === 403 ? "Forbidden" : "Not found");
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => handleMessage(ws, raw));
  ws.on("close", () => handleDisconnect(ws));
  ws.on("error", () => handleDisconnect(ws));
  send(ws, "hello", { message: "CueWeave 同步服务已连接" });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

await loadRooms();

httpServer.listen(PORT, HOST, () => {
  console.log(`CueWeave 已启动：http://localhost:${PORT}`);
  console.log(`局域网设备请访问：http://<本机局域网IP>:${PORT}`);
});

async function shutdown() {
  clearInterval(heartbeat);
  for (const room of rooms.values()) {
    if (room.ownerTimer) clearTimeout(room.ownerTimer);
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
  }
  try { await persistRooms(); } catch (error) { console.error("关闭前保存房间数据失败：", error.message); }
  for (const ws of wss.clients) ws.close(1012, "服务正在重启");
  setTimeout(() => {
    for (const ws of wss.clients) ws.terminate();
  }, 800).unref();
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { cleanState, cleanPlayback, permissions };
