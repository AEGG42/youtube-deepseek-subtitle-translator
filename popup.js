(function initializePopup() {
  "use strict";

  const Shared = globalThis.DeepSeekTranslatorShared;
  const enabledInput = document.getElementById("popup-enabled");
  const notice = document.getElementById("notice");
  const noticeText = document.getElementById("notice-text");
  const liveDot = document.getElementById("live-dot");
  const liveStatus = document.getElementById("live-status");
  const liveDetail = document.getElementById("live-detail");
  const languageSummary = document.getElementById("summary-language");
  const modelSummary = document.getElementById("summary-model");
  const modeSummary = document.getElementById("summary-mode");
  const retranslateButton = document.getElementById("retranslate");
  const retranslateDetail = document.getElementById("retranslate-detail");
  const openOptionsButton = document.getElementById("open-options");

  let activeTabId = null;
  let hasApiKey = false;
  const previewMode = !globalThis.chrome?.runtime?.sendMessage;

  enabledInput.addEventListener("change", handleEnabledChange);
  retranslateButton.addEventListener("click", retranslateCurrentCaption);
  openOptionsButton.addEventListener("click", () => {
    if (globalThis.chrome?.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

  if (previewMode) {
    renderSettings(Shared.DEFAULT_SETTINGS);
    retranslateButton.disabled = true;
    setLiveState(
      "未打开 YouTube",
      "打开视频后，扩展会自动读取已开启的字幕。"
    );
    return;
  }
  void initialize();

  async function initialize() {
    try {
      const settingsResponse = await sendRuntimeMessage({
        type: "GET_EXTENSION_SETTINGS"
      });

      if (!settingsResponse?.ok) {
        throw new Error(settingsResponse?.error?.message || "读取设置失败");
      }

      hasApiKey = settingsResponse.hasApiKey;
      renderSettings(settingsResponse.settings);

      if (!hasApiKey) {
        showNotice("请先打开设置并填写你自己的 DeepSeek API Key。");
      }

      await inspectActiveTab();
    } catch (error) {
      showNotice(error.message, true);
      setLiveState("扩展暂时不可用", "请重新加载扩展后再试。", "error");
    }
  }

  function renderSettings(settings) {
    const normalized = Shared.sanitizeSettings(settings);
    enabledInput.checked = normalized.enabled;
    languageSummary.textContent =
      Shared.TARGET_LANGUAGES[normalized.targetLanguage] ||
      normalized.targetLanguage;
    modelSummary.textContent = normalized.model.includes("flash")
      ? "V4 Flash"
      : "V4 Pro";
    modeSummary.textContent =
      normalized.displayMode === "bilingual" ? "双语" : "仅译文";
  }

  async function inspectActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    activeTabId = activeTab?.id ?? null;

    if (
      !activeTab ||
      !activeTab.url?.startsWith("https://www.youtube.com/")
    ) {
      retranslateButton.disabled = true;
      retranslateDetail.textContent = "未检测到活动视频";
      setLiveState("未打开 YouTube", "打开视频后，扩展会自动读取已开启的字幕。");
      return;
    }

    try {
      const response = await sendTabMessage(activeTab.id, {
        type: "GET_TRANSLATOR_STATUS"
      });
      renderTabStatus(response?.status);
    } catch {
      retranslateButton.disabled = true;
      setLiveState(
        "需要刷新 YouTube 页面",
        "扩展刚安装或更新后，请刷新当前视频页。",
        "warning"
      );
    }
  }

  function renderTabStatus(status) {
    retranslateButton.disabled =
      !hasApiKey ||
      (!status?.captionFound && !status?.hasTranslation);
    retranslateDetail.textContent = retranslateButton.disabled
      ? "当前没有可重译字幕"
      : "重新处理正在显示的字幕";

    if (!enabledInput.checked) {
      setLiveState("翻译已暂停", "使用右上角开关重新启用。");
      return;
    }
    if (!hasApiKey) {
      setLiveState("等待 API Key", "完成设置后即可开始翻译。", "warning");
      return;
    }
    if (status?.error) {
      setLiveState("最近一次翻译失败", status.error, "error");
      return;
    }
    if (!status?.playerFound) {
      setLiveState("未检测到视频", "请打开一个 YouTube 视频。");
      return;
    }
    if (status?.isTranslating) {
      setLiveState("DeepSeek 翻译中", "正在实时补译当前字幕…", "active");
      return;
    }
    if (
      status?.prefetchStatus === "loading" ||
      status?.prefetchStatus === "retrying"
    ) {
      setLiveState("正在读取完整字幕", "字幕轨就绪后会优先翻译当前播放位置。", "active");
      return;
    }
    if (
      status?.prefetchStatus === "translating" &&
      status?.prefetchTotal > 0
    ) {
      setLiveState(
        "整段字幕预翻译中",
        `已完成 ${status.prefetchTranslated}/${status.prefetchTotal} 条，当前位置优先。`,
        "active"
      );
      return;
    }
    if (
      ["ready", "partial"].includes(status?.prefetchStatus) &&
      status?.prefetchTotal > 0
    ) {
      const complete =
        status.prefetchTranslated >= status.prefetchTotal
          ? "整段字幕已就绪"
          : "整段字幕部分就绪";
      setLiveState(
        complete,
        `已缓存 ${status.prefetchTranslated}/${status.prefetchTotal} 条译文。`,
        "active"
      );
      return;
    }
    if (!status?.captionFound) {
      setLiveState(
        "等待字幕",
        "完整字幕不可预取时，请在播放器中开启 CC 以使用实时翻译。",
        "warning"
      );
      return;
    }
    if (status?.hasTranslation) {
      setLiveState("翻译运行中", "当前字幕已显示译文。", "active");
      return;
    }

    setLiveState("已检测到字幕", "下一句字幕出现时会自动翻译。", "active");
  }

  async function handleEnabledChange() {
    if (previewMode) {
      setLiveState(
        enabledInput.checked ? "翻译已启用" : "翻译已暂停",
        enabledInput.checked
          ? "打开 YouTube 视频后会自动读取字幕。"
          : "使用右上角开关重新启用。",
        enabledInput.checked ? "active" : ""
      );
      return;
    }

    enabledInput.disabled = true;

    try {
      const response = await sendRuntimeMessage({
        type: "SET_EXTENSION_ENABLED",
        enabled: enabledInput.checked
      });

      if (!response?.ok) {
        throw new Error(response?.error?.message || "更新开关失败");
      }

      await inspectActiveTab();
    } catch (error) {
      enabledInput.checked = !enabledInput.checked;
      showNotice(error.message, true);
    } finally {
      enabledInput.disabled = false;
    }
  }

  async function retranslateCurrentCaption() {
    if (!activeTabId) {
      return;
    }

    retranslateButton.disabled = true;
    try {
      await sendTabMessage(activeTabId, { type: "FORCE_RETRANSLATE" });
      setLiveState("已请求重新翻译", "DeepSeek 正在处理当前字幕…", "active");
    } catch (error) {
      showNotice(error.message, true);
    }
  }

  function setLiveState(title, detail, state = "") {
    liveStatus.textContent = title;
    liveDetail.textContent = detail;
    liveDot.className = "live-dot";
    liveDot.src =
      state === "active"
        ? "assets/icons/circle-check.svg"
        : "assets/icons/alert-circle.svg";
    if (state) {
      liveDot.classList.add(state);
    }
  }

  function showNotice(message, isError = false) {
    notice.hidden = false;
    notice.classList.toggle("error", isError);
    noticeText.textContent = message;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }
})();
