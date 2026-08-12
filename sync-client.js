(() => {
  "use strict";

  const SESSION_KEY = "cueweave-sync-session-v1";
  const RECENT_ROOMS_KEY = "cueweave-recent-rooms-v1";
  const NAME_KEY = "cueweave-device-name-v1";
  const LEGACY_SESSION_KEY = "liuguang-sync-session-v1";
  const LEGACY_NAME_KEY = "liuguang-device-name-v1";
  const $ = (id) => document.getElementById(id);
  const roleLabels = { owner: "房主", editor: "编辑者", operator: "操作者", viewer: "查看者" };
  const modeLabels = { control: "控制端", editor: "编辑端", director: "导播端", display: "显示端" };

  class SyncClient extends EventTarget {
    constructor() {
      super();
      this.ws = null;
      const previousSession = this.loadSession();
      this.recentRooms = this.loadRecentRooms(previousSession);
      this.session = null;
      this.room = null;
      this.permissions = null;
      this.pendingMessages = [];
      this.pendingPatch = {};
      this.patchTimer = null;
      this.reconnectTimer = null;
      this.reconnectDelay = 1000;
      this.manualDisconnect = false;
      this.inviteRoomId = null;
      this.autoJoinRequested = false;
      this.inviteOrigin = null;
      this.stateProvider = () => ({});
      this.playbackProvider = () => ({ playing: false, progress: 0, speed: 45 });
      this.bindUI();
      this.prepareFromUrl();
      this.updateConnection("offline");
      if (this.session?.roomId && location.protocol !== "file:") this.connect(true);
    }

    loadSession() {
      try {
        const stored = localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || "null";
        if (!localStorage.getItem(SESSION_KEY) && stored !== "null") localStorage.setItem(SESSION_KEY, stored);
        return JSON.parse(stored);
      }
      catch { return null; }
    }

    loadRecentRooms(previousSession) {
      let rooms = [];
      try {
        const stored = JSON.parse(localStorage.getItem(RECENT_ROOMS_KEY) || "[]");
        if (Array.isArray(stored)) rooms = stored;
      } catch {}
      if (previousSession?.roomId && !rooms.some((room) => room.roomId === previousSession.roomId)) {
        rooms.unshift({ ...previousSession, lastVisitedAt: Date.now() });
      }
      return rooms
        .filter((room) => /^[A-Z2-9]{6}$/.test(String(room?.roomId || "")) && room.deviceId && room.reconnectToken)
        .sort((a, b) => Number(b.lastVisitedAt || 0) - Number(a.lastVisitedAt || 0))
        .slice(0, 20);
    }

    saveRecentRooms() {
      localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(this.recentRooms));
    }

    recentRoom(roomId) {
      return this.recentRooms.find((room) => room.roomId === roomId) || null;
    }

    persistSession(data) {
      this.session = { ...data, lastVisitedAt: Date.now() };
      this.recentRooms = [this.session, ...this.recentRooms.filter((room) => room.roomId !== data.roomId)].slice(0, 20);
      localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
      this.saveRecentRooms();
      localStorage.setItem(NAME_KEY, data.name);
      localStorage.removeItem(LEGACY_SESSION_KEY);
      localStorage.removeItem(LEGACY_NAME_KEY);
      this.renderRecentRooms();
    }

    bindUI() {
      const defaultName = localStorage.getItem(NAME_KEY) || localStorage.getItem(LEGACY_NAME_KEY) || this.defaultDeviceName();
      $("deviceNameInput").value = defaultName;
      $("syncToggle").addEventListener("click", () => {
        if (!this.room) this.showSetupStep("choice");
        $("syncDialog").showModal();
      });
      $("closeSyncButton").addEventListener("click", () => $("syncDialog").close());
      $("syncDialog").addEventListener("cancel", (event) => event.preventDefault());
      $("createRoomChoice").addEventListener("click", () => this.showSetupStep("create"));
      $("joinRoomChoice").addEventListener("click", () => this.showSetupStep("join"));
      $("localOnlyChoice").addEventListener("click", () => $("syncDialog").close());
      $("syncSetupBack").addEventListener("click", () => this.showSetupStep("choice"));
      $("createRoomButton").addEventListener("click", () => this.createRoom());
      $("joinRoomButton").addEventListener("click", () => this.joinRoom());
      $("roomCodeInput").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""); });
      $("roomCodeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") this.joinRoom(); });
      $("currentRoomCode").addEventListener("click", () => this.copyInvite());
      $("copyInviteButton").addEventListener("click", () => this.copyInvite());
      $("inviteModeSelect").addEventListener("change", () => this.updateInviteUI());
      $("roomModeSelect").addEventListener("change", (event) => this.send("room.mode", { mode: event.target.value }));
      $("leaveRoomButton").addEventListener("click", () => this.leaveRoom());
      $("closeRoomButton").addEventListener("click", () => {
        if (window.confirm("关闭后所有设备会断开，当前房间无法恢复。确定关闭吗？")) this.send("room.close");
      });
      this.renderRecentRooms();
    }

    showSetupStep(step) {
      const choice = step === "choice";
      $("syncChoice").classList.toggle("hidden", !choice);
      $("syncFormStep").classList.toggle("hidden", choice);
      if (choice) {
        $("syncDialogTitle").textContent = "多端同步";
        this.setupMessage("");
        this.renderRecentRooms();
        return;
      }
      const joining = step === "join";
      $("syncCreateFields").classList.toggle("hidden", joining);
      $("syncJoinFields").classList.toggle("hidden", !joining);
      $("syncDialogTitle").textContent = joining ? "加入房间" : "新建房间";
      $("syncStepTitle").textContent = joining ? "加入已有房间" : "创建新的同步房间";
      $("syncStepDescription").textContent = joining ? "输入房间号，即可与其他设备同步。" : "你将成为房主，并可以邀请其他设备。";
      this.setupMessage("");
      requestAnimationFrame(() => (joining ? $("roomCodeInput") : $("deviceNameInput")).focus());
    }

    prepareFromUrl() {
      const params = new URLSearchParams(location.search);
      const pathMatch = location.pathname.match(/^\/room\/([A-Z2-9]{6})\/?$/i);
      const roomId = (pathMatch?.[1] || params.get("room") || "").toUpperCase();
      const deviceMode = params.get("mode");
      if (roomId) $("roomCodeInput").value = roomId.slice(0, 6);
      if (["control", "editor", "director", "display"].includes(deviceMode)) $("deviceModeInput").value = deviceMode;
      if (roomId) {
        this.inviteRoomId = roomId.slice(0, 6);
        this.autoJoinRequested = true;
        this.session = this.recentRoom(this.inviteRoomId);
        if (this.session) {
          $("deviceNameInput").value = this.session.name || $("deviceNameInput").value;
          $("deviceModeInput").value = this.session.deviceMode || $("deviceModeInput").value;
        }
        if (!this.session) requestAnimationFrame(() => {
          this.showSetupStep("join");
          $("syncDialog").showModal();
        });
      } else if (location.protocol !== "file:") {
        requestAnimationFrame(() => {
          this.showSetupStep("choice");
          $("syncDialog").showModal();
        });
      }
    }

    defaultDeviceName() {
      const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
      return mobile ? "我的移动设备" : "我的电脑";
    }

    newDeviceId() {
      if (crypto.randomUUID) return crypto.randomUUID();
      return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");
    }

    setProviders(stateProvider, playbackProvider) {
      this.stateProvider = stateProvider;
      this.playbackProvider = playbackProvider;
      if (this.autoJoinRequested && !this.session) this.joinRoom(true);
    }

    endpoint() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${location.host}/ws`;
    }

    connect(resume = false) {
      if (location.protocol === "file:") {
        this.setupMessage("直接打开 HTML 只能本地使用，请通过 npm start 启动同步服务。", true);
        return;
      }
      if (this.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.ws.readyState)) return;
      this.manualDisconnect = false;
      this.updateConnection("connecting");
      this.ws = new WebSocket(this.endpoint());
      this.ws.addEventListener("open", () => {
        this.reconnectDelay = 1000;
        this.updateConnection("connected");
        if (resume && this.session?.roomId) {
          this.send("room.join", this.session);
        }
        while (this.pendingMessages.length) this.ws.send(this.pendingMessages.shift());
      });
      this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
      this.ws.addEventListener("close", (event) => this.handleClose(event));
      this.ws.addEventListener("error", () => this.updateConnection("error"));
    }

    send(type, payload = {}) {
      const encoded = JSON.stringify({ type, payload, sentAt: Date.now() });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encoded);
      else {
        this.pendingMessages.push(encoded);
        this.connect(Boolean(this.session?.roomId));
      }
    }

    createRoom() {
      const name = $("deviceNameInput").value.trim() || this.defaultDeviceName();
      const deviceMode = $("deviceModeInput").value;
      this.setupMessage("正在创建房间…");
      this.send("room.create", {
        name,
        deviceMode,
        roomMode: $("newRoomModeInput").value,
        deviceId: this.newDeviceId(),
        state: this.stateProvider(),
        playback: this.playbackProvider()
      });
    }

    joinRoom(automatic = false) {
      const roomId = (this.inviteRoomId || $("roomCodeInput").value).trim().toUpperCase();
      if (roomId.length !== 6) return this.setupMessage("请输入正确的 6 位房间码。", true);
      const name = $("deviceNameInput").value.trim() || this.defaultDeviceName();
      this.setupMessage(automatic ? "正在通过邀请链接自动加入…" : "正在加入房间…");
      const recent = this.recentRoom(roomId);
      if (recent) {
        this.session = { ...recent, name };
        if (this.ws?.readyState === WebSocket.OPEN) this.send("room.join", this.session);
        else this.connect(true);
        return;
      }
      this.send("room.join", { roomId, name, deviceMode: $("deviceModeInput").value });
    }

    enterRecentRoom(roomId) {
      const recent = this.recentRoom(roomId);
      if (!recent) return;
      this.inviteRoomId = roomId;
      $("roomCodeInput").value = roomId;
      $("deviceNameInput").value = recent.name || $("deviceNameInput").value;
      $("deviceModeInput").value = recent.deviceMode || "control";
      this.joinRoom();
    }

    forgetRecentRoom(roomId) {
      this.recentRooms = this.recentRooms.filter((room) => room.roomId !== roomId);
      this.saveRecentRooms();
      if (this.session?.roomId === roomId && !this.room) {
        this.session = null;
        localStorage.removeItem(SESSION_KEY);
      }
      this.renderRecentRooms();
    }

    renderRecentRooms() {
      const section = $("recentRoomsSection");
      const list = $("recentRoomList");
      if (!section || !list) return;
      section.classList.toggle("hidden", !this.recentRooms.length);
      list.replaceChildren();
      this.recentRooms.forEach((room) => {
        const row = document.createElement("div");
        row.className = "recent-room";
        const copy = document.createElement("div");
        copy.className = "recent-room-copy";
        const code = document.createElement("b");
        code.textContent = room.roomId;
        const detail = document.createElement("small");
        const role = roleLabels[room.role] || "成员";
        const mode = modeLabels[room.deviceMode] || "控制端";
        const visited = room.lastVisitedAt ? new Date(room.lastVisitedAt).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间未知";
        detail.textContent = `${role} · ${mode} · ${visited}`;
        copy.append(code, detail);
        const actions = document.createElement("div");
        actions.className = "recent-room-actions";
        const enter = document.createElement("button");
        enter.type = "button";
        enter.textContent = "进入";
        enter.addEventListener("click", () => this.enterRecentRoom(room.roomId));
        const forget = document.createElement("button");
        forget.type = "button";
        forget.textContent = "×";
        forget.title = "仅从当前浏览器移除记录";
        forget.setAttribute("aria-label", `移除房间 ${room.roomId} 记录`);
        forget.addEventListener("click", () => this.forgetRecentRoom(room.roomId));
        actions.append(enter, forget);
        row.append(copy, actions);
        list.append(row);
      });
    }

    handleMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const payload = message.payload || {};
      if (["room.created", "room.joined"].includes(message.type)) {
        this.persistSession({
          roomId: payload.roomId,
          deviceId: payload.self.deviceId,
          reconnectToken: payload.reconnectToken,
          name: payload.self.name,
          deviceMode: payload.self.deviceMode,
          role: payload.self.role,
          roomMode: payload.mode
        });
        this.applySnapshot(payload);
        this.setupMessage("");
        if (this.autoJoinRequested && $("syncDialog").open) $("syncDialog").close();
        this.autoJoinRequested = false;
        this.setRoomUrl(payload.roomId);
        return;
      }
      if (message.type === "room.snapshot") return this.applySnapshot(payload);
      if (message.type === "state.patch") {
        this.dispatchEvent(new CustomEvent("remote-state", { detail: payload }));
        return;
      }
      if (message.type === "playback.updated") {
        this.dispatchEvent(new CustomEvent("remote-playback", { detail: payload }));
        return;
      }
      if (message.type === "members.updated") {
        this.room = { ...this.room, ...payload };
        this.permissions = payload.permissions;
        this.applyPermissions();
        this.renderRoom();
        return;
      }
      if (message.type === "owner.changed") {
        this.roomMessage(payload.newOwnerId === this.session?.deviceId ? "原房主已离线，你已成为新房主。" : "房间控制权已移交。", false);
        return;
      }
      if (message.type === "room.closed") {
        if (this.session?.roomId) this.forgetRecentRoom(this.session.roomId);
        this.clearLocalSession(true);
        this.setupMessage(payload.message || "房间已关闭", true);
        return;
      }
      if (message.type === "error") {
        if (payload.snapshot) this.applySnapshot(payload.snapshot);
        if (payload.code === "ROOM_NOT_FOUND") {
          const missingRoomId = this.session?.roomId || this.inviteRoomId;
          if (missingRoomId) this.forgetRecentRoom(missingRoomId);
          this.clearLocalSession(true);
          this.showSetupStep("join");
          if (missingRoomId) $("roomCodeInput").value = missingRoomId;
        }
        const inRoom = Boolean(this.room);
        (inRoom ? this.roomMessage.bind(this) : this.setupMessage.bind(this))(payload.message || "同步操作失败", true);
      }
    }

    applySnapshot(payload) {
      this.room = payload;
      this.permissions = payload.permissions;
      this.dispatchEvent(new CustomEvent("remote-state", { detail: { patch: payload.state, replace: true } }));
      this.dispatchEvent(new CustomEvent("remote-playback", { detail: payload.playback }));
      this.applyPermissions();
      this.renderRoom();
      $("syncSetup").classList.add("hidden");
      $("syncRoom").classList.remove("hidden");
      this.updateConnection("connected");
      this.updateInviteUI();
    }

    applyPermissions() {
      if (!this.room?.self || !this.permissions) return;
      document.body.dataset.deviceMode = this.room.self.deviceMode;
      document.body.dataset.roomRole = this.room.self.role;
      if (this.room.self.deviceMode === "display") {
        document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
        this.dispatchEvent(new CustomEvent("display-mode"));
      }
      const setDisabled = (ids, disabled) => ids.forEach((id) => { const element = $(id); if (element) element.disabled = disabled; });
      setDisabled(["editorToggle", "inlineEditButton", "clearButton"], !this.permissions.editScript);
      setDisabled(["fontSize", "lineHeight", "letterSpacing", "contentWidth", "guidePosition", "backgroundColor", "textColor", "guideColor", "showGuide", "resetButton"], !this.permissions.editAppearance);
      setDisabled(["playButton", "speedDown", "speedUp", "scrollSpeed"], !this.permissions.controlPlayback);
      setDisabled(["backToTopButton"], !this.permissions.controlProgress);
      this.dispatchEvent(new CustomEvent("permissions", { detail: this.permissions }));
    }

    renderRoom() {
      if (!this.room) return;
      $("currentRoomCode").textContent = this.room.roomId;
      $("roomModeSelect").value = this.room.mode;
      const isOwner = Boolean(this.permissions?.manageRoom);
      $("ownerControls").classList.toggle("hidden", !isOwner);
      $("closeRoomButton").classList.toggle("hidden", !isOwner);
      const members = this.room.members || [];
      $("memberCount").textContent = `${members.filter((member) => member.connected).length} 台在线`;
      const list = $("memberList");
      list.replaceChildren();
      members.forEach((member) => list.append(this.memberRow(member, isOwner)));
      this.updateInviteUI();
    }

    memberRow(member, canManage) {
      const row = document.createElement("div");
      row.className = `member-row${member.deviceId === this.room.self.deviceId ? " is-self" : ""}${member.connected ? "" : " is-offline"}`;
      const identity = document.createElement("div");
      identity.className = "member-identity";
      const dot = document.createElement("i");
      const copy = document.createElement("span");
      const name = document.createElement("b");
      name.textContent = member.name;
      const detail = document.createElement("small");
      detail.textContent = `${roleLabels[member.role]} · ${modeLabels[member.deviceMode]}${member.deviceId === this.room.self.deviceId ? " · 本机" : ""}`;
      copy.append(name, detail);
      identity.append(dot, copy);
      row.append(identity);
      if (canManage && member.role !== "owner") {
        const controls = document.createElement("div");
        controls.className = "member-controls";
        const role = document.createElement("select");
        [["editor", "编辑者"], ["operator", "操作者"], ["viewer", "查看者"]].forEach(([value, label]) => role.add(new Option(label, value)));
        role.value = member.role;
        role.title = "用户角色";
        role.addEventListener("change", () => this.send("member.update", { deviceId: member.deviceId, role: role.value }));
        const device = document.createElement("select");
        [["control", "控制端"], ["editor", "编辑端"], ["director", "导播端"], ["display", "显示端"]].forEach(([value, label]) => device.add(new Option(label, value)));
        device.value = member.deviceMode;
        device.title = "设备用途";
        device.addEventListener("change", () => this.send("member.update", { deviceId: member.deviceId, deviceMode: device.value }));
        const transfer = document.createElement("button");
        transfer.type = "button";
        transfer.textContent = "移交";
        transfer.disabled = !member.connected || member.deviceMode === "display";
        transfer.addEventListener("click", () => {
          if (window.confirm(`将房主身份移交给“${member.name}”吗？`)) this.send("owner.transfer", { deviceId: member.deviceId });
        });
        controls.append(role, device, transfer);
        row.append(controls);
      }
      return row;
    }

    sendStatePatch(patch) {
      if (!this.room || !patch || !Object.keys(patch).length) return;
      this.pendingPatch = { ...this.pendingPatch, ...patch };
      clearTimeout(this.patchTimer);
      this.patchTimer = setTimeout(() => {
        const next = this.pendingPatch;
        this.pendingPatch = {};
        this.send("state.patch", { patch: next });
      }, "script" in patch ? 220 : 60);
    }

    sendPlayback(action, playback = this.playbackProvider()) {
      if (!this.room) return;
      this.send("playback.update", { action, ...playback });
    }

    updateConnection(status) {
      const labels = { offline: "多端同步", connecting: "连接中…", connected: "同步正常", error: "连接异常" };
      $("connectionLabel").textContent = labels[status];
      $("connectionDot").dataset.status = status;
      $("roomConnectionDot").dataset.status = status;
      $("roomConnectionText").textContent = status === "connected" ? "同步正常" : status === "connecting" ? "正在重连" : "已离线";
    }

    handleClose(event) {
      this.updateConnection("offline");
      if (event?.code === 4001) {
        clearTimeout(this.reconnectTimer);
        this.manualDisconnect = true;
        this.roomMessage("同一设备已在其他页面连接，本页面已停止自动重连。", true);
        return;
      }
      if (this.manualDisconnect || !this.session?.roomId) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(true), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
    }

    async resolveInviteOrigin() {
      if (this.inviteOrigin) return this.inviteOrigin;
      const localHostname = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
      if (!localHostname) return (this.inviteOrigin = location.origin);
      try {
        const response = await fetch("/api/info", { cache: "no-store" });
        const info = await response.json();
        const serverOrigin = (info.origins || []).find((origin) => {
          try { return !["localhost", "127.0.0.1", "::1"].includes(new URL(origin).hostname); }
          catch { return false; }
        });
        return (this.inviteOrigin = serverOrigin || location.origin);
      } catch {
        return (this.inviteOrigin = location.origin);
      }
    }

    async buildInviteUrl() {
      if (!this.room) return "";
      const url = new URL(await this.resolveInviteOrigin());
      url.pathname = `/room/${this.room.roomId}`;
      url.search = "";
      url.searchParams.set("mode", $("inviteModeSelect").value);
      return url.toString();
    }

    async updateInviteUI() {
      if (!this.room) return;
      const invite = await this.buildInviteUrl();
      $("inviteUrlInput").value = invite;
      $("inviteQrImage").src = `/api/qr?data=${encodeURIComponent(invite)}`;
      const inviteHost = new URL(invite).host;
      $("inviteTip").textContent = `二维码使用服务器地址 ${inviteHost}；扫码后会自动加入。`;
    }

    async copyInvite() {
      const invite = await this.buildInviteUrl();
      navigator.clipboard?.writeText(invite).then(
        () => this.roomMessage("邀请网址已复制，打开后会自动加入。"),
        () => this.roomMessage(`邀请网址：${invite}`)
      );
    }

    setRoomUrl(roomId) {
      if (!history.replaceState) return;
      const url = new URL(location.href);
      url.pathname = `/room/${roomId}`;
      url.search = "";
      history.replaceState(null, "", `${url.pathname}${url.hash}`);
    }

    setEntryUrl() {
      if (history.replaceState) history.replaceState(null, "", "/");
    }

    leaveRoom() {
      this.manualDisconnect = true;
      this.ws?.close(1000, "主动退出");
      this.clearLocalSession(true);
    }

    clearLocalSession(showSetup) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_SESSION_KEY);
      this.session = null;
      this.room = null;
      this.permissions = null;
      this.inviteRoomId = null;
      this.autoJoinRequested = false;
      this.setEntryUrl();
      document.body.dataset.deviceMode = "control";
      document.body.dataset.roomRole = "";
      ["editorToggle", "inlineEditButton", "clearButton", "fontSize", "lineHeight", "letterSpacing", "contentWidth", "guidePosition", "backgroundColor", "textColor", "guideColor", "showGuide", "mirrorHorizontal", "mirrorVertical", "resetButton", "playButton", "speedDown", "speedUp", "scrollSpeed", "backToTopButton"].forEach((id) => {
        const element = $(id);
        if (element) element.disabled = false;
      });
      if (showSetup) {
        $("syncRoom").classList.add("hidden");
        $("syncSetup").classList.remove("hidden");
        this.showSetupStep("choice");
        if (!$("syncDialog").open) $("syncDialog").showModal();
      }
      this.updateConnection("offline");
    }

    setupMessage(text, error = false) {
      $("syncSetupMessage").textContent = text;
      $("syncSetupMessage").classList.toggle("error", error);
    }

    roomMessage(text, error = false) {
      $("syncRoomMessage").textContent = text;
      $("syncRoomMessage").classList.toggle("error", error);
      if (text) setTimeout(() => { if ($("syncRoomMessage").textContent === text) $("syncRoomMessage").textContent = ""; }, 4000);
    }
  }

  window.teleprompterSync = new SyncClient();
})();
