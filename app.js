(() => {
  "use strict";

  const STORAGE_KEY = "liuguang-teleprompter-v1";
  const LOCAL_VIEW_KEY = "liuguang-local-view-v1";
  const DEFAULT_SCRIPT = `大家好，欢迎来到今天的分享。\n\n这是一款专注、清晰，而且足够灵活的提词器。你可以在左侧随时修改文字，在下方控制滚动速度。\n\n开始之前，先调整字号、行间距和阅读宽度，让画面适合你的阅读习惯。\n\n准备好之后，按下空格键。把视线停留在横线上，文字会自然地经过你的阅读位置。\n\n愿每一次表达，都从容、准确、有力量。`;
  const defaults = {
    script: DEFAULT_SCRIPT,
    fontSize: 58,
    lineHeight: 1.5,
    letterSpacing: 1,
    contentWidth: 76,
    backgroundColor: "#07090d",
    textColor: "#f5f1e9",
    guideColor: "#ff6b4a",
    guidePosition: 46,
    showGuide: true,
    mirrorHorizontal: false,
    mirrorVertical: false,
    scrollSpeed: 45,
    focusMode: false
  };

  const $ = (id) => document.getElementById(id);
  const elements = {
    appShell: $("appShell"), scriptInput: $("scriptInput"), promptContent: $("promptContent"),
    stage: $("prompterStage"), stageEmpty: $("stageEmpty"), guideLine: $("guideLine"),
    charCount: $("charCount"), saveState: $("saveState"), playButton: $("playButton"),
    playTitle: $("playTitle"), mirrorBadge: $("mirrorBadge"), visualAid: $("visualAid"),
    aidTitle: $("aidTitle"), aidValue: $("aidValue"), aidTip: $("aidTip"),
    stageWrap: $("stageWrap"), inlineEditButton: $("inlineEditButton"), inlineEditHint: $("inlineEditHint"),
    editorToggle: $("editorToggle"), editorDialog: $("editorDialog"), closeEditorButton: $("closeEditorButton"),
    appearanceButton: $("appearanceButton"), appearancePopover: $("appearancePopover"),
    followRoomMirror: $("followRoomMirror"), displayFollowMirror: $("displayFollowMirror"),
    displayMirrorHorizontal: $("displayMirrorHorizontal"), displayMirrorVertical: $("displayMirrorVertical")
  };

  const controlIds = ["fontSize", "lineHeight", "letterSpacing", "contentWidth", "guidePosition", "scrollSpeed"];
  const colorIds = ["backgroundColor", "textColor", "guideColor"];
  let state = loadState();
  let localView = loadLocalView();
  let isPlaying = false;
  let lastFrameTime = 0;
  let animationFrame = null;
  let saveTimer = null;
  let aidTimer = null;
  let isInlineEditing = false;
  let applyingRemoteState = false;
  let applyingRemotePlayback = false;
  let ownsPlaybackClock = false;
  let remotePlaybackAnchor = null;
  let preciseScrollTop = null;
  let lastProgressBroadcast = 0;
  let manualProgressTimer = null;
  let manualScrollActive = false;
  let manualScrollChanged = false;
  let manualScrollResumeTimer = null;
  let lastManualProgressBroadcast = 0;
  let remoteManualTarget = null;
  let lastRemoteScrollWriteAt = 0;
  const sync = window.teleprompterSync;
  const sharedStateKeys = Object.keys(defaults).filter((key) => key !== "focusMode");
  const REFERENCE_STAGE_WIDTH = 1000;

  function loadState() {
    try {
      const loaded = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"), focusMode: false };
      delete loaded.innerPadding;
      delete loaded.outerMargin;
      delete loaded.editorCollapsed;
      return loaded;
    } catch {
      return { ...defaults };
    }
  }

  function loadLocalView() {
    try {
      return {
        followRoomMirror: true,
        mirrorHorizontal: false,
        mirrorVertical: false,
        ...JSON.parse(localStorage.getItem(LOCAL_VIEW_KEY) || "{}")
      };
    } catch {
      return { followRoomMirror: true, mirrorHorizontal: false, mirrorVertical: false };
    }
  }

  function saveLocalView() {
    localStorage.setItem(LOCAL_VIEW_KEY, JSON.stringify(localView));
  }

  function saveState(changedKeys = sharedStateKeys) {
    window.clearTimeout(saveTimer);
    elements.saveState.innerHTML = "<i></i> 正在保存";
    saveTimer = window.setTimeout(() => {
      const persistentState = { ...state, focusMode: false };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState));
      elements.saveState.innerHTML = "<i></i> 已自动保存";
    }, 280);
    if (!applyingRemoteState && sync) {
      const patch = {};
      changedKeys.forEach((key) => { if (sharedStateKeys.includes(key)) patch[key] = state[key]; });
      sync.sendStatePatch(patch);
    }
  }

  function setRangeProgress(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    input.style.setProperty("--range-progress", `${((value - min) / (max - min)) * 100}%`);
  }

  function updateOutputs() {
    $("fontSizeValue").value = `${state.fontSize}px`;
    $("lineHeightValue").value = Number(state.lineHeight).toFixed(2).replace(/0$/, "");
    $("letterSpacingValue").value = `${state.letterSpacing}px`;
    $("contentWidthValue").value = `${state.contentWidth}%`;
    $("guidePositionValue").value = `${state.guidePosition}%`;
    $("scrollSpeedValue").value = `${state.scrollSpeed}`;
    colorIds.forEach((id) => { $(`${id}Value`).textContent = state[id].toUpperCase(); });
  }

  function applyState() {
    elements.scriptInput.value = state.script;
    controlIds.forEach((id) => { $(id).value = state[id]; setRangeProgress($(id)); });
    colorIds.forEach((id) => { $(id).value = state[id]; });
    $("showGuide").checked = state.showGuide;
    document.documentElement.style.setProperty("--prompt-line-height", state.lineHeight);
    document.documentElement.style.setProperty("--prompt-width", `${state.contentWidth}%`);
    document.documentElement.style.setProperty("--stage-background", state.backgroundColor);
    document.documentElement.style.setProperty("--stage-text", state.textColor);
    document.documentElement.style.setProperty("--guide-color", state.guideColor);
    document.documentElement.style.setProperty("--guide-position", `${state.guidePosition}%`);
    applyResponsiveLayout();
    elements.guideLine.classList.toggle("hidden", !state.showGuide);
    elements.appShell.classList.toggle("focus-mode", state.focusMode);
    if (isInlineEditing) updateScriptMeta();
    else renderScript();
    updateMirror();
    updateOutputs();
  }

  function renderScript() {
    elements.promptContent.replaceChildren();
    elements.promptContent.classList.add("unified-layout");
    const fragment = document.createDocumentFragment();
    unifiedLines(state.script).forEach((line, index) => {
      const row = document.createElement("span");
      row.className = "prompt-line";
      row.dataset.line = String(index);
      row.textContent = line || "\u00a0";
      fragment.append(row);
    });
    elements.promptContent.append(fragment);
    updateScriptMeta();
  }

  function applyResponsiveLayout() {
    const stageWidth = elements.stage.clientWidth || REFERENCE_STAGE_WIDTH;
    const stageHeight = elements.stage.clientHeight || window.innerHeight;
    const supportsContainerUnits = window.CSS?.supports?.("font-size", "1cqw");
    document.documentElement.style.setProperty(
      "--prompt-font-size",
      supportsContainerUnits ? `${state.fontSize / 10}cqw` : `${state.fontSize * stageWidth / REFERENCE_STAGE_WIDTH}px`
    );
    document.documentElement.style.setProperty(
      "--prompt-letter-spacing",
      supportsContainerUnits ? `${state.letterSpacing / 10}cqw` : `${state.letterSpacing * stageWidth / REFERENCE_STAGE_WIDTH}px`
    );
    document.documentElement.style.setProperty("--prompt-padding-top", `${stageHeight * state.guidePosition / 100}px`);
    document.documentElement.style.setProperty("--prompt-padding-bottom", `${stageHeight * (100 - state.guidePosition) / 100}px`);
  }

  function graphemes(text) {
    if (window.Intl?.Segmenter) {
      return [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    }
    return Array.from(text);
  }

  function glyphUnits(glyph) {
    return /^[\x00-\xff]$/.test(glyph) ? (glyph === " " ? 0.4 : 0.55) : 1;
  }

  function unifiedLines(script) {
    const advance = Math.max(1, state.fontSize + state.letterSpacing);
    const unitsPerLine = Math.max(4, (REFERENCE_STAGE_WIDTH * state.contentWidth / 100) / advance);
    const lines = [];
    String(script).replace(/\r\n?/g, "\n").split("\n").forEach((paragraph) => {
      if (!paragraph) {
        lines.push("");
        return;
      }
      let line = "";
      let used = 0;
      graphemes(paragraph).forEach((glyph) => {
        const units = glyphUnits(glyph);
        if (line && used + units > unitsPerLine) {
          lines.push(line);
          line = "";
          used = 0;
        }
        line += glyph;
        used += units;
      });
      lines.push(line);
    });
    return lines.length ? lines : [""];
  }

  function updateScriptMeta() {
    const length = state.script.replace(/\s/g, "").length;
    elements.charCount.textContent = `${length.toLocaleString("zh-CN")} 字`;
    elements.stageEmpty.classList.toggle("hidden", state.script.trim().length > 0);
  }

  function updateMirror() {
    const horizontal = localView.followRoomMirror ? state.mirrorHorizontal : localView.mirrorHorizontal;
    const vertical = localView.followRoomMirror ? state.mirrorVertical : localView.mirrorVertical;
    const x = !isInlineEditing && horizontal ? -1 : 1;
    const y = !isInlineEditing && vertical ? -1 : 1;
    elements.promptContent.style.transform = `scale(${x}, ${y})`;
    elements.mirrorBadge.textContent = localView.followRoomMirror ? "房间镜像已开启" : "本机镜像已开启";
    elements.mirrorBadge.classList.toggle("visible", !isInlineEditing && (horizontal || vertical));
    elements.followRoomMirror.checked = localView.followRoomMirror;
    elements.displayFollowMirror.setAttribute("aria-pressed", String(localView.followRoomMirror));
    [["mirrorHorizontal", "displayMirrorHorizontal", horizontal], ["mirrorVertical", "displayMirrorVertical", vertical]].forEach(([normalId, displayId, active]) => {
      $(normalId).setAttribute("aria-pressed", String(active));
      $(displayId).setAttribute("aria-pressed", String(active));
    });
    updateMirrorPermissions();
  }

  function updateMirrorPermissions() {
    const disabled = localView.followRoomMirror && !hasPermission("editAppearance");
    $("mirrorHorizontal").disabled = disabled;
    $("mirrorVertical").disabled = disabled;
    elements.displayMirrorHorizontal.disabled = disabled;
    elements.displayMirrorVertical.disabled = disabled;
  }

  function setFollowRoomMirror(follow) {
    if (!follow && localView.followRoomMirror) {
      localView.mirrorHorizontal = state.mirrorHorizontal;
      localView.mirrorVertical = state.mirrorVertical;
    }
    localView.followRoomMirror = follow;
    saveLocalView();
    updateMirror();
  }

  function toggleMirror(key) {
    if (localView.followRoomMirror) {
      if (!hasPermission("editAppearance")) return;
      state[key] = !state[key];
      saveState([key]);
    } else {
      localView[key] = !localView[key];
      saveLocalView();
    }
    updateMirror();
  }

  function readInlineText() {
    return elements.promptContent.innerText.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  }

  function placeCaretAtPoint(x, y) {
    let range = null;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
      }
    } else if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    }
    if (!range || !elements.promptContent.contains(range.startContainer)) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function enterInlineEdit(point) {
    if (isInlineEditing || !state.script.trim() || !hasPermission("editScript")) return;
    const shouldBroadcastPause = isPlaying && ownsPlaybackClock;
    stopPlayback();
    if (shouldBroadcastPause) sync?.sendPlayback("pause", getPlaybackSnapshot());
    isInlineEditing = true;
    elements.promptContent.classList.remove("unified-layout");
    elements.promptContent.textContent = state.script;
    window.clearTimeout(aidTimer);
    elements.visualAid.classList.remove("visible");
    elements.promptContent.setAttribute("contenteditable", "plaintext-only");
    elements.promptContent.setAttribute("spellcheck", "true");
    elements.stageWrap.classList.add("editing");
    elements.inlineEditButton.innerHTML = "<span>✓</span> 完成编辑";
    elements.inlineEditButton.setAttribute("aria-pressed", "true");
    elements.inlineEditHint.textContent = "Esc 或 Ctrl + Enter 完成";
    updateMirror();
    requestAnimationFrame(() => {
      elements.promptContent.focus({ preventScroll: true });
      if (point) {
        placeCaretAtPoint(point.x, point.y);
      } else {
        const rect = elements.stage.getBoundingClientRect();
        placeCaretAtPoint(rect.left + rect.width / 2, rect.top + rect.height * state.guidePosition / 100);
      }
    });
  }

  function exitInlineEdit() {
    if (!isInlineEditing) return;
    state.script = readInlineText();
    isInlineEditing = false;
    elements.promptContent.removeAttribute("contenteditable");
    elements.promptContent.setAttribute("spellcheck", "false");
    elements.stageWrap.classList.remove("editing");
    elements.inlineEditButton.innerHTML = "<span>✎</span> 编辑文稿";
    elements.inlineEditButton.setAttribute("aria-pressed", "false");
    elements.inlineEditHint.textContent = "双击文字可原位修改";
    elements.scriptInput.value = state.script;
    renderScript();
    updateMirror();
    saveState(["script"]);
  }

  function stopPlayback() {
    isPlaying = false;
    lastFrameTime = 0;
    manualScrollActive = false;
    window.clearTimeout(manualScrollResumeTimer);
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = null;
    elements.playButton.classList.remove("playing");
    elements.playButton.setAttribute("aria-label", "开始自动滚动");
    elements.playTitle.textContent = "开始滚动";
    ownsPlaybackClock = false;
    remotePlaybackAnchor = null;
    remoteManualTarget = null;
    preciseScrollTop = null;
  }

  function tick(timestamp) {
    if (!isPlaying && !remoteManualTarget) {
      animationFrame = null;
      return;
    }
    if (manualScrollActive) {
      preciseScrollTop = elements.stage.scrollTop;
      lastFrameTime = timestamp;
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    if (!lastFrameTime) lastFrameTime = timestamp;
    const deltaSeconds = Math.min((timestamp - lastFrameTime) / 1000, 0.05);
    lastFrameTime = timestamp;
    const previous = elements.stage.scrollTop;
    if (preciseScrollTop !== null && Math.abs(previous - preciseScrollTop) > 2) {
      preciseScrollTop = previous;
    }
    if (remoteManualTarget) {
      if (preciseScrollTop === null) preciseScrollTop = previous;
      const drift = remoteManualTarget.position - preciseScrollTop;
      const followAmount = 1 - Math.exp(-10 * deltaSeconds);
      preciseScrollTop += drift * followAmount;
      if (Math.abs(drift) < 0.75) preciseScrollTop = remoteManualTarget.position;
      lastRemoteScrollWriteAt = performance.now();
      elements.stage.scrollTop = preciseScrollTop;
      const targetAge = performance.now() - remoteManualTarget.receivedAt;
      if (Math.abs(remoteManualTarget.position - preciseScrollTop) < 0.75 && targetAge > 120) {
        const completedTarget = remoteManualTarget;
        remoteManualTarget = null;
        if (completedTarget.playing) {
          remotePlaybackAnchor = {
            position: preciseScrollTop,
            speed: localScrollSpeed(),
            receivedAt: performance.now(),
            playing: true
          };
        } else {
          lastFrameTime = 0;
          animationFrame = null;
          return;
        }
      }
      animationFrame = requestAnimationFrame(tick);
      return;
    }
    const baseSpeed = localScrollSpeed();
    let effectiveSpeed = baseSpeed;
    if (!ownsPlaybackClock && remotePlaybackAnchor?.playing) {
      const elapsedSeconds = Math.max(0, (performance.now() - remotePlaybackAnchor.receivedAt) / 1000);
      const expectedPosition = remotePlaybackAnchor.position + remotePlaybackAnchor.speed * elapsedSeconds;
      const drift = expectedPosition - elements.stage.scrollTop;
      const correctionLimit = Math.max(baseSpeed * 0.15, baseSpeed * 0.25);
      const correction = Math.abs(drift) < 4 ? 0 : Math.max(-correctionLimit, Math.min(correctionLimit, drift * 0.35));
      effectiveSpeed = Math.max(baseSpeed * 0.7, baseSpeed + correction);
    }
    if (preciseScrollTop === null) preciseScrollTop = elements.stage.scrollTop;
    preciseScrollTop += effectiveSpeed * deltaSeconds;
    elements.stage.scrollTop = preciseScrollTop;
    const reachedEnd = elements.stage.scrollTop >= elements.stage.scrollHeight - elements.stage.clientHeight - 1;
    if (reachedEnd && elements.stage.scrollTop === previous) {
      const shouldBroadcastPause = ownsPlaybackClock;
      stopPlayback();
      elements.playTitle.textContent = "已到结尾";
      if (!applyingRemotePlayback && shouldBroadcastPause) sync?.sendPlayback("pause", getPlaybackSnapshot());
      return;
    }
    if (!applyingRemotePlayback && ownsPlaybackClock && sync?.permissions?.controlProgress && timestamp - lastProgressBroadcast >= 400) {
      lastProgressBroadcast = timestamp;
      sync.sendPlayback("sync", getPlaybackSnapshot());
    }
    animationFrame = requestAnimationFrame(tick);
  }

  function beginManualScroll() {
    if (!hasPermission("controlProgress")) return;
    window.clearTimeout(manualScrollResumeTimer);
    manualScrollActive = true;
    manualScrollChanged = false;
    preciseScrollTop = elements.stage.scrollTop;
    if (isPlaying) ownsPlaybackClock = true;
    remotePlaybackAnchor = null;
    remoteManualTarget = null;
  }

  function finishManualScroll(delay = 100) {
    if (!manualScrollActive) return;
    window.clearTimeout(manualScrollResumeTimer);
    manualScrollResumeTimer = window.setTimeout(() => {
      manualScrollActive = false;
      preciseScrollTop = elements.stage.scrollTop;
      lastFrameTime = 0;
      window.clearTimeout(manualProgressTimer);
      if (manualScrollChanged && sync?.permissions?.controlProgress) {
        sync.sendPlayback("scrub", getPlaybackSnapshot());
        lastProgressBroadcast = performance.now();
        lastManualProgressBroadcast = lastProgressBroadcast;
      }
      manualScrollChanged = false;
    }, delay);
  }

  function broadcastManualProgress() {
    if (!sync?.permissions?.controlProgress) return;
    const now = performance.now();
    const remaining = 50 - (now - lastManualProgressBroadcast);
    window.clearTimeout(manualProgressTimer);
    if (remaining <= 0) {
      sync.sendPlayback("scrub", getPlaybackSnapshot());
      lastManualProgressBroadcast = now;
      return;
    }
    manualProgressTimer = window.setTimeout(() => {
      sync.sendPlayback("scrub", getPlaybackSnapshot());
      lastManualProgressBroadcast = performance.now();
    }, remaining);
  }

  function togglePlayback() {
    if (!hasPermission("controlPlayback")) return;
    if (isInlineEditing) exitInlineEdit();
    if (isPlaying) {
      stopPlayback();
      sync?.sendPlayback("pause", getPlaybackSnapshot());
      return;
    }
    if (!state.script.trim()) return;
    if (elements.stage.scrollTop >= elements.stage.scrollHeight - elements.stage.clientHeight - 2) elements.stage.scrollTop = 0;
    preciseScrollTop = elements.stage.scrollTop;
    isPlaying = true;
    ownsPlaybackClock = true;
    elements.playButton.classList.add("playing");
    elements.playButton.setAttribute("aria-label", "暂停自动滚动");
    elements.playTitle.textContent = "正在滚动";
    animationFrame = requestAnimationFrame(tick);
    sync?.sendPlayback("play", getPlaybackSnapshot());
  }

  function changeSpeed(delta) {
    if (!hasPermission("controlPlayback")) return;
    state.scrollSpeed = Math.min(180, Math.max(5, state.scrollSpeed + delta));
    $("scrollSpeed").value = state.scrollSpeed;
    setRangeProgress($("scrollSpeed"));
    updateOutputs();
    showVisualAid("scrollSpeed");
    saveState(["scrollSpeed"]);
  }

  function getAidCopy(id) {
    const value = state[id];
    const copy = {
      fontSize: {
        title: "字号",
        value: `${value} px`,
        tip: value < 42 ? "字号偏小，远离屏幕时可能吃力。" : value > 92 ? "适合远距离阅读，注意每行字数会减少。" : "适合桌面和中近距离提词。"
      },
      lineHeight: {
        title: "行间距",
        value: `${Number(value).toFixed(2).replace(/0$/, "")} · ${Math.round(state.fontSize * value)} px/行`,
        tip: value < 1.3 ? "行距较密，建议提高到 1.35 以上。" : value > 1.9 ? "行距较松，视线移动距离会更长。" : "当前行距舒展，适合连续阅读。"
      },
      contentWidth: {
        title: "阅读宽度",
        value: `${value}%`,
        tip: value < 55 ? "内容较窄，适合短句和近距离阅读。" : value > 85 ? "单行可能过长，视线横向移动会增加。" : "宽度适中，视线容易回到下一行。"
      },
      guidePosition: {
        title: "阅读定位线",
        value: `${value}%`,
        tip: value < 35 ? "位置偏上，适合镜头位于屏幕上方。" : value > 58 ? "位置偏下，可能让视线远离镜头。" : "位于常用阅读区，容易保持视线稳定。"
      },
      scrollSpeed: {
        title: "自动滚动速度",
        value: `${value}`,
        tip: value < 30 ? "慢速，适合停顿较多的讲解。" : value > 100 ? "速度较快，建议先试读确认节奏。" : "适合正常语速，可边读边微调。"
      }
    };
    return copy[id];
  }

  function hideVisualAid(delay = 900) {
    window.clearTimeout(aidTimer);
    aidTimer = window.setTimeout(() => {
      elements.visualAid.classList.remove("visible");
    }, delay);
  }

  function showVisualAid(id, keepVisible = false) {
    const copy = getAidCopy(id);
    if (!copy || state.focusMode) return;
    window.clearTimeout(aidTimer);

    if (id === "lineHeight" || id === "fontSize" || id === "letterSpacing") {
      elements.visualAid.hidden = true;
      elements.visualAid.classList.remove("visible");
      elements.visualAid.removeAttribute("data-aid");
      return;
    }

    elements.visualAid.hidden = false;
    elements.visualAid.dataset.aid = id;
    elements.aidTitle.textContent = copy.title;
    elements.aidValue.textContent = copy.value;
    elements.aidTip.textContent = copy.tip;
    elements.visualAid.classList.add("visible");
    if (!keepVisible) hideVisualAid(1100);
  }

  function toggleFocus() {
    closeAppearancePopover();
    if (elements.editorDialog.open) elements.editorDialog.close();
    state.focusMode = !state.focusMode;
    elements.appShell.classList.toggle("focus-mode", state.focusMode);
  }

  function setAppearancePopover(open) {
    elements.appearancePopover.classList.toggle("open", open);
    elements.appearancePopover.setAttribute("aria-hidden", String(!open));
    elements.appearanceButton.setAttribute("aria-expanded", String(open));
  }

  function closeAppearancePopover() {
    setAppearancePopover(false);
  }

  function backToTop() {
    if (!hasPermission("controlProgress")) return;
    stopPlayback();
    elements.stage.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    sync?.sendPlayback("top", { ...getPlaybackSnapshot(), playing: false, progress: 0 });
  }

  function hasPermission(permission) {
    return !sync?.room || Boolean(sync.permissions?.[permission]);
  }

  function getProgress() {
    const maximum = elements.stage.scrollHeight - elements.stage.clientHeight;
    return maximum > 0 ? Math.min(1, Math.max(0, elements.stage.scrollTop / maximum)) : 0;
  }

  function getLayoutMetrics() {
    const style = getComputedStyle(elements.promptContent);
    const lineHeight = Number.parseFloat(style.lineHeight) || state.fontSize * state.lineHeight;
    const textOrigin = elements.promptContent.offsetTop + (Number.parseFloat(style.paddingTop) || 0);
    const guideY = elements.stage.clientHeight * state.guidePosition / 100;
    return { lineHeight, textOrigin, guideY };
  }

  function getLineAnchor() {
    const { lineHeight, textOrigin, guideY } = getLayoutMetrics();
    return lineHeight > 0 ? (elements.stage.scrollTop + guideY - textOrigin) / lineHeight : 0;
  }

  function scrollTopForAnchor(anchor) {
    const { lineHeight, textOrigin, guideY } = getLayoutMetrics();
    const maximum = Math.max(0, elements.stage.scrollHeight - elements.stage.clientHeight);
    return Math.min(maximum, Math.max(0, textOrigin + anchor * lineHeight - guideY));
  }

  function localScrollSpeed() {
    return state.scrollSpeed * elements.stage.clientWidth / REFERENCE_STAGE_WIDTH;
  }

  function getPlaybackSnapshot() {
    return {
      playing: isPlaying,
      progress: getProgress(),
      anchor: getLineAnchor(),
      speed: state.scrollSpeed,
      extent: Math.max(0, elements.stage.scrollHeight - elements.stage.clientHeight)
    };
  }

  function applyRemotePlayback(playback) {
    if (!playback) return;
    applyingRemotePlayback = true;
    ownsPlaybackClock = Boolean(playback.playing && playback.sourceDeviceId && playback.sourceDeviceId === sync?.session?.deviceId);
    if (Number.isFinite(Number(playback.speed))) {
      state.scrollSpeed = Number(playback.speed);
      $("scrollSpeed").value = state.scrollSpeed;
      setRangeProgress($("scrollSpeed"));
      updateOutputs();
    }
    requestAnimationFrame(() => {
      const maximum = elements.stage.scrollHeight - elements.stage.clientHeight;
      const target = Number.isFinite(Number(playback.anchor))
        ? scrollTopForAnchor(Number(playback.anchor))
        : Math.max(0, maximum * Math.min(1, Math.max(0, Number(playback.progress) || 0)));
      const action = playback.action || "snapshot";
      const drift = target - elements.stage.scrollTop;
      if (action === "scrub") {
        if (!playback.playing && isPlaying) stopPlayback();
        remoteManualTarget = {
          position: target,
          receivedAt: performance.now(),
          playing: Boolean(playback.playing)
        };
        remotePlaybackAnchor = null;
        preciseScrollTop = elements.stage.scrollTop;
        if (playback.playing && !isPlaying && state.script.trim()) {
          isPlaying = true;
          elements.playButton.classList.add("playing");
          elements.playButton.setAttribute("aria-label", "暂停自动滚动");
          elements.playTitle.textContent = "正在滚动";
        }
        if (!animationFrame) animationFrame = requestAnimationFrame(tick);
        applyingRemotePlayback = false;
        return;
      }
      const requiresExactPosition = !playback.playing || action === "play" || action === "pause" || action === "seek" || action === "top" || action === "snapshot";
      if (requiresExactPosition) {
        elements.stage.scrollTop = target;
        preciseScrollTop = target;
      } else if (preciseScrollTop === null) {
        preciseScrollTop = elements.stage.scrollTop;
      }
      remotePlaybackAnchor = playback.playing && !ownsPlaybackClock ? {
        position: target,
        speed: localScrollSpeed(),
        receivedAt: performance.now(),
        playing: true
      } : null;
      if (playback.playing && !isPlaying && state.script.trim()) {
        isPlaying = true;
        elements.playButton.classList.add("playing");
        elements.playButton.setAttribute("aria-label", "暂停自动滚动");
        elements.playTitle.textContent = "正在滚动";
        animationFrame = requestAnimationFrame(tick);
      } else if (!playback.playing && isPlaying) stopPlayback();
      applyingRemotePlayback = false;
    });
  }

  function bindEvents() {
    elements.editorToggle.addEventListener("click", () => {
      if (isInlineEditing) exitInlineEdit();
      closeAppearancePopover();
      elements.scriptInput.value = state.script;
      elements.editorDialog.showModal();
      requestAnimationFrame(() => elements.scriptInput.focus({ preventScroll: true }));
    });
    elements.closeEditorButton.addEventListener("click", () => elements.editorDialog.close());
    elements.editorDialog.addEventListener("click", (event) => {
      if (event.target === elements.editorDialog) elements.editorDialog.close();
    });
    elements.appearanceButton.addEventListener("click", (event) => {
      event.stopPropagation();
      setAppearancePopover(elements.appearanceButton.getAttribute("aria-expanded") !== "true");
    });
    elements.appearancePopover.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("click", closeAppearancePopover);
    elements.inlineEditButton.addEventListener("click", () => {
      if (isInlineEditing) exitInlineEdit();
      else enterInlineEdit();
    });
    elements.promptContent.addEventListener("dblclick", (event) => {
      if (!isInlineEditing) {
        event.preventDefault();
        enterInlineEdit({ x: event.clientX, y: event.clientY });
      }
    });
    elements.promptContent.addEventListener("input", () => {
      if (!isInlineEditing) return;
      state.script = readInlineText();
      elements.scriptInput.value = state.script;
      updateScriptMeta();
      saveState(["script"]);
    });
    elements.promptContent.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
        event.preventDefault();
        event.stopPropagation();
        exitInlineEdit();
        elements.stage.focus({ preventScroll: true });
      }
    });
    elements.scriptInput.addEventListener("focus", () => { if (isInlineEditing) exitInlineEdit(); });
    elements.scriptInput.addEventListener("input", (event) => {
      state.script = event.target.value;
      renderScript();
      saveState(["script"]);
    });
    controlIds.forEach((id) => {
      $(id).addEventListener("input", (event) => {
        state[id] = Number(event.target.value);
        setRangeProgress(event.target);
        applyState();
        showVisualAid(id);
        saveState([id]);
      });
      const row = $(id).closest(".setting-row, .speed-control");
      row.addEventListener("pointerenter", () => showVisualAid(id, true));
      row.addEventListener("pointerleave", () => hideVisualAid(260));
      $(id).addEventListener("focus", () => showVisualAid(id));
      $(id).addEventListener("blur", () => hideVisualAid(500));
    });
    colorIds.forEach((id) => {
      $(id).addEventListener("input", (event) => {
        state[id] = event.target.value;
        applyState();
        saveState([id]);
      });
    });
    $("showGuide").addEventListener("change", (event) => { state.showGuide = event.target.checked; applyState(); saveState(["showGuide"]); });
    elements.followRoomMirror.addEventListener("change", (event) => setFollowRoomMirror(event.target.checked));
    elements.displayFollowMirror.addEventListener("click", () => setFollowRoomMirror(!localView.followRoomMirror));
    [["mirrorHorizontal", "mirrorHorizontal"], ["mirrorVertical", "mirrorVertical"], ["displayMirrorHorizontal", "mirrorHorizontal"], ["displayMirrorVertical", "mirrorVertical"]].forEach(([id, key]) => {
      $(id).addEventListener("click", () => toggleMirror(key));
    });
    elements.playButton.addEventListener("click", togglePlayback);
    $("speedDown").addEventListener("click", () => changeSpeed(-5));
    $("speedUp").addEventListener("click", () => changeSpeed(5));
    $("backToTopButton").addEventListener("click", backToTop);
    $("focusButton").addEventListener("click", toggleFocus);
    $("miniFocusButton").addEventListener("click", toggleFocus);
    $("clearButton").addEventListener("click", () => {
      if (isInlineEditing) exitInlineEdit();
      if (!state.script || window.confirm("确定清空当前提词稿吗？")) {
        state.script = ""; applyState(); saveState(["script"]); elements.scriptInput.focus();
      }
    });
    $("resetButton").addEventListener("click", () => {
      if (isInlineEditing) exitInlineEdit();
      if (window.confirm("恢复默认文字和全部设置吗？")) {
        stopPlayback(); state = { ...defaults }; elements.stage.scrollTop = 0; applyState(); saveState(sharedStateKeys);
      }
    });
    $("fullscreenButton").addEventListener("click", async () => {
      try {
        if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); if (!state.focusMode) toggleFocus(); }
        else await document.exitFullscreen();
      } catch { toggleFocus(); }
    });
    document.addEventListener("fullscreenchange", () => {
      $("fullscreenButton").innerHTML = document.fullscreenElement ? "<span aria-hidden=\"true\">⛶</span> 退出全屏" : "<span aria-hidden=\"true\">⛶</span> 全屏提词";
    });
    document.addEventListener("keydown", (event) => {
      const interacting = event.target.matches("textarea, input, button, dialog") || (isInlineEditing && elements.promptContent.contains(event.target));
      if (event.code === "Space" && !interacting) { event.preventDefault(); togglePlayback(); }
      if (!interacting && event.key === "ArrowUp") { event.preventDefault(); changeSpeed(5); }
      if (!interacting && event.key === "ArrowDown") { event.preventDefault(); changeSpeed(-5); }
      if (!interacting && event.key.toLowerCase() === "r") { event.preventDefault(); backToTop(); }
      if (!interacting && event.key.toLowerCase() === "f") { event.preventDefault(); toggleFocus(); }
      if (!interacting && event.key === "Enter") $("fullscreenButton").click();
      if (event.key === "Escape") closeAppearancePopover();
      if (event.key === "Escape" && state.focusMode && !document.fullscreenElement) toggleFocus();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && isPlaying) {
        const shouldBroadcast = ownsPlaybackClock;
        stopPlayback();
        if (shouldBroadcast) sync?.sendPlayback("pause", getPlaybackSnapshot());
      }
    });
    elements.stage.addEventListener("wheel", () => {
      beginManualScroll();
      finishManualScroll(140);
    }, { passive: true });
    elements.stage.addEventListener("keydown", (event) => {
      if (!["PageUp", "PageDown", "Home", "End"].includes(event.key)) return;
      beginManualScroll();
      finishManualScroll(160);
    });
    elements.stage.addEventListener("pointerdown", beginManualScroll, { passive: true });
    document.addEventListener("pointerup", () => finishManualScroll(80), { passive: true });
    document.addEventListener("pointercancel", () => finishManualScroll(80), { passive: true });
    elements.stage.addEventListener("scroll", () => {
      if (applyingRemotePlayback || !sync?.permissions?.controlProgress) return;
      if (performance.now() - lastRemoteScrollWriteAt < 80) return;
      if (isPlaying && !manualScrollActive) return;
      preciseScrollTop = elements.stage.scrollTop;
      if (manualScrollActive) {
        manualScrollChanged = true;
        broadcastManualProgress();
        return;
      }
      window.clearTimeout(manualProgressTimer);
      manualProgressTimer = window.setTimeout(() => sync.sendPlayback("seek", getPlaybackSnapshot()), 180);
    }, { passive: true });
  }

  bindEvents();
  applyState();
  if (window.ResizeObserver) {
    let previousStageWidth = elements.stage.clientWidth;
    let previousLineHeight = getLayoutMetrics().lineHeight;
    const resizeObserver = new ResizeObserver(() => {
      const oldAnchor = previousLineHeight > 0 ? elements.stage.scrollTop / previousLineHeight : 0;
      applyResponsiveLayout();
      const nextLineHeight = getLayoutMetrics().lineHeight;
      if (previousStageWidth && elements.stage.clientWidth !== previousStageWidth) {
        elements.stage.scrollTop = Math.max(0, oldAnchor * nextLineHeight);
        preciseScrollTop = elements.stage.scrollTop;
      }
      previousStageWidth = elements.stage.clientWidth;
      previousLineHeight = nextLineHeight;
    });
    resizeObserver.observe(elements.stage);
  }
  if (sync) {
    sync.setProviders(() => {
      const snapshot = {};
      sharedStateKeys.forEach((key) => { snapshot[key] = state[key]; });
      return snapshot;
    }, getPlaybackSnapshot);
    sync.addEventListener("remote-state", (event) => {
      applyingRemoteState = true;
      state = { ...state, ...event.detail.patch, focusMode: state.focusMode };
      applyState();
      const persistentState = { ...state, focusMode: false };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persistentState));
      applyingRemoteState = false;
    });
    sync.addEventListener("remote-playback", (event) => applyRemotePlayback(event.detail));
    sync.addEventListener("display-mode", () => {
      if (isInlineEditing) exitInlineEdit();
      closeAppearancePopover();
    });
    sync.addEventListener("permissions", updateMirrorPermissions);
  }
})();
