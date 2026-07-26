(function initializeOptionsPage() {
  "use strict";

  const Shared = globalThis.DeepSeekTranslatorShared;

  const form = document.getElementById("settings-form");
  const enabledInput = document.getElementById("enabled");
  const enabledCaption = document.getElementById("enabled-caption");
  const prefetchEnabledInput = document.getElementById("prefetch-enabled");
  const wordLookupEnabledInput = document.getElementById(
    "word-lookup-enabled"
  );
  const wordLookupAiFallbackInput = document.getElementById(
    "word-lookup-ai-fallback"
  );
  const apiKeyInput = document.getElementById("api-key");
  const keyState = document.getElementById("key-state");
  const keyHelp = document.getElementById("key-help");
  const clearKeyButton = document.getElementById("clear-key");
  const toggleKeyButton = document.getElementById("toggle-key");
  const modelSelect = document.getElementById("model");
  const languageSelect = document.getElementById("target-language");
  const fontSizeInput = document.getElementById("font-size");
  const opacityInput = document.getElementById("background-opacity");
  const bottomInput = document.getElementById("subtitle-bottom");
  const delayInput = document.getElementById("translation-delay");
  const testButton = document.getElementById("test-connection");
  const saveButton = document.getElementById("save-settings");
  const saveStatus = document.getElementById("save-status");
  const resetDefaultsButton = document.getElementById("reset-defaults");
  const copyEndpointButton = document.getElementById("copy-endpoint");
  const previewYouTubeButton = document.getElementById("preview-youtube");
  const endpointInput = document.getElementById("endpoint");
  const connectionResult = document.getElementById("connection-result");
  const lastTest = document.getElementById("last-test");
  const previewCaption = document.getElementById("preview-caption");
  const previewSource = document.getElementById("preview-source");
  const previewTranslation = document.getElementById("preview-translation");
  const overviewLanguage = document.getElementById("overview-language");
  const overviewMode = document.getElementById("overview-mode");
  const overviewModel = document.getElementById("overview-model");
  const overviewPrefetch = document.getElementById("overview-prefetch");
  const overviewDelay = document.getElementById("overview-delay");

  let hasStoredApiKey = false;
  let maskedApiKey = "";
  let isBusy = false;
  const previewMode = !canUseExtensionRuntime();

  bindEvents();
  if (previewMode) {
    loadPreviewState();
    return;
  }
  void loadSettings();

  function bindEvents() {
    form.addEventListener("submit", handleSave);
    testButton.addEventListener("click", handleTestConnection);
    clearKeyButton.addEventListener("click", handleClearKey);
    toggleKeyButton.addEventListener("click", toggleKeyVisibility);
    resetDefaultsButton.addEventListener("click", handleResetDefaults);
    copyEndpointButton.addEventListener("click", handleCopyEndpoint);
    previewYouTubeButton.addEventListener("click", handlePreviewYouTube);
    enabledInput.addEventListener("change", () => {
      updateEnabledCaption();
      updateOverview();
    });
    prefetchEnabledInput.addEventListener("change", updateOverview);
    wordLookupEnabledInput.addEventListener("change", () => {
      updateWordLookupState();
      updatePreview();
    });
    wordLookupAiFallbackInput.addEventListener("change", updateOverview);
    modelSelect.addEventListener("change", updateOverview);
    languageSelect.addEventListener("change", updateOverview);

    [
      fontSizeInput,
      opacityInput,
      bottomInput,
      delayInput
    ].forEach((input) => input.addEventListener("input", updatePreview));

    form
      .querySelectorAll("input[name='displayMode']")
      .forEach((input) => input.addEventListener("change", updatePreview));
  }

  async function loadSettings() {
    setBusy(true);
    setStatus("正在读取设置…");

    try {
      const response = await sendMessage({ type: "GET_EXTENSION_SETTINGS" });
      if (!response?.ok) {
        throw new Error(response?.error?.message || "无法读取设置");
      }

      populateForm(response.settings);
      hasStoredApiKey = response.hasApiKey;
      maskedApiKey = response.maskedApiKey || "";
      updateKeyState();
      setConnectionStatus(
        hasStoredApiKey
          ? "已配置密钥，可测试连接。"
          : "填写 API Key 后即可测试连接。"
      );
      setStatus("设置已载入");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function populateForm(settings) {
    const normalized = Shared.sanitizeSettings(settings);
    enabledInput.checked = normalized.enabled;
    prefetchEnabledInput.checked = normalized.prefetchEnabled;
    wordLookupEnabledInput.checked = normalized.wordLookupEnabled;
    wordLookupAiFallbackInput.checked = normalized.wordLookupAiFallback;
    modelSelect.value = normalized.model;
    languageSelect.value = normalized.targetLanguage;
    fontSizeInput.value = String(normalized.fontSize);
    opacityInput.value = String(
      Math.round(normalized.backgroundOpacity * 100)
    );
    bottomInput.value = String(normalized.subtitleBottom);
    delayInput.value = String(normalized.translationDelay);

    const modeInput = form.querySelector(
      `input[name="displayMode"][value="${normalized.displayMode}"]`
    );
    if (modeInput) {
      modeInput.checked = true;
    }

    updateEnabledCaption();
    updateWordLookupState();
    updatePreview();
  }

  async function handleSave(event) {
    event.preventDefault();
    await saveForm();
  }

  async function saveForm() {
    if (isBusy) {
      return false;
    }

    if (previewMode) {
      updateOverview();
      setStatus("预览设置已保存", "success");
      return true;
    }

    setBusy(true);
    setStatus("正在保存…");

    try {
      const payload = collectSettings();
      const enteredKey = apiKeyInput.value.trim();
      if (enteredKey) {
        payload.apiKey = enteredKey;
      }

      const response = await sendMessage({
        type: "SAVE_EXTENSION_SETTINGS",
        payload
      });

      if (!response?.ok) {
        throw new Error(response?.error?.message || "保存失败");
      }

      hasStoredApiKey = response.hasApiKey;
      maskedApiKey = response.maskedApiKey || "";
      apiKeyInput.value = "";
      populateForm(response.settings);
      updateKeyState();
      setConnectionStatus("设置已保存，可测试连接。", "success");
      setStatus("已保存，YouTube 页面会自动应用", "success");
      return true;
    } catch (error) {
      setStatus(error.message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleTestConnection() {
    if (isBusy) {
      return;
    }

    if (previewMode) {
      setConnectionStatus("连接成功，可正常调用 API。", "success");
      lastTest.textContent = "上次测试：刚刚";
      setStatus("连接测试完成", "success");
      return;
    }

    const saved = await saveForm();
    if (!saved) {
      return;
    }

    setBusy(true);
    setStatus("正在连接 DeepSeek…");

    try {
      const response = await sendMessage({
        type: "TEST_DEEPSEEK_CONNECTION"
      });

      if (!response?.ok) {
        throw new Error(response?.error?.message || "连接失败");
      }

      const latency = Number(response.latencyMs) || 0;
      const tokens = Number(response.usage?.totalTokens) || 0;
      const tokenText = tokens ? ` · ${tokens} tokens` : "";
      setConnectionStatus(`连接成功，可正常调用 API${tokenText}。`, "success");
      lastTest.textContent = `上次测试：${latency} ms`;
      setStatus(`连接成功 · ${latency} ms${tokenText}`, "success");
    } catch (error) {
      setConnectionStatus(error.message, "error");
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleClearKey() {
    if (!hasStoredApiKey || isBusy) {
      return;
    }

    const shouldClear = window.confirm(
      "确定清除浏览器中保存的 DeepSeek API Key 吗？"
    );
    if (!shouldClear) {
      return;
    }

    if (previewMode) {
      hasStoredApiKey = false;
      maskedApiKey = "";
      apiKeyInput.value = "";
      updateKeyState();
      setConnectionStatus("填写 API Key 后即可测试连接。");
      setStatus("已清除 API Key", "success");
      return;
    }

    setBusy(true);
    setStatus("正在清除密钥…");

    try {
      const response = await sendMessage({
        type: "SAVE_EXTENSION_SETTINGS",
        payload: { apiKey: "" }
      });

      if (!response?.ok) {
        throw new Error(response?.error?.message || "清除失败");
      }

      hasStoredApiKey = false;
      maskedApiKey = "";
      apiKeyInput.value = "";
      updateKeyState();
      setConnectionStatus("填写 API Key 后即可测试连接。");
      setStatus("已清除 API Key", "success");
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function collectSettings() {
    const selectedMode = form.querySelector(
      "input[name='displayMode']:checked"
    );

    return {
      enabled: enabledInput.checked,
      prefetchEnabled: prefetchEnabledInput.checked,
      wordLookupEnabled: wordLookupEnabledInput.checked,
      wordLookupAiFallback: wordLookupAiFallbackInput.checked,
      model: modelSelect.value,
      targetLanguage: languageSelect.value,
      displayMode: selectedMode?.value || "bilingual",
      fontSize: Number(fontSizeInput.value),
      backgroundOpacity: Number(opacityInput.value) / 100,
      subtitleBottom: Number(bottomInput.value),
      translationDelay: Number(delayInput.value)
    };
  }

  function updateKeyState() {
    const stateText = hasStoredApiKey ? "连接已配置" : "未配置";
    const stateIcon = hasStoredApiKey
      ? "assets/icons/circle-check.svg"
      : "assets/icons/alert-circle.svg";
    keyState.innerHTML = `<img src="${stateIcon}" alt="" />${stateText}`;
    keyState.classList.toggle("state-badge--success", hasStoredApiKey);
    keyState.classList.toggle("state-badge--warning", !hasStoredApiKey);
    clearKeyButton.disabled = !hasStoredApiKey;
    apiKeyInput.placeholder = hasStoredApiKey
      ? "输入新的 DeepSeek API Key"
      : "输入你的 DeepSeek API Key";
    keyHelp.textContent = hasStoredApiKey
      ? `当前密钥：${maskedApiKey}（仅保存在本地浏览器中，留空保存不会修改）`
      : "密钥仅保存在本地浏览器的扩展存储中，不会写入项目代码。";
  }

  function toggleKeyVisibility() {
    const showing = apiKeyInput.type === "text";
    apiKeyInput.type = showing ? "password" : "text";
    toggleKeyButton.setAttribute(
      "aria-label",
      showing ? "显示 API Key" : "隐藏 API Key"
    );
  }

  function updateEnabledCaption() {
    enabledCaption.textContent = enabledInput.checked ? "已启用" : "已暂停";
  }

  function updateWordLookupState() {
    wordLookupAiFallbackInput.disabled = !wordLookupEnabledInput.checked;
  }

  function updatePreview() {
    const size = Number(fontSizeInput.value);
    const opacity = Number(opacityInput.value) / 100;
    const mode =
      form.querySelector("input[name='displayMode']:checked")?.value ||
      "bilingual";

    document.getElementById("font-size-output").textContent = `${size} px`;
    document.getElementById("background-opacity-output").textContent =
      `${opacityInput.value}%`;
    document.getElementById("subtitle-bottom-output").textContent =
      `${bottomInput.value}%`;
    document.getElementById("translation-delay-output").textContent =
      `${delayInput.value} ms`;

    previewTranslation.style.fontSize = `${Math.max(18, size * 0.86)}px`;
    previewSource.style.fontSize = `${Math.max(12, size * 0.5)}px`;
    previewCaption.style.backgroundColor = `rgba(15, 15, 15, ${opacity})`;
    previewSource.hidden = mode === "translationOnly";
    updateOverview();
  }

  function setBusy(busy) {
    isBusy = busy;
    saveButton.disabled = busy;
    testButton.disabled = busy;
    resetDefaultsButton.disabled = busy;
  }

  function setStatus(message, kind = "") {
    saveStatus.textContent = message;
    saveStatus.classList.toggle("success", kind === "success");
    saveStatus.classList.toggle("error", kind === "error");
  }

  function updateOverview() {
    const selectedMode =
      form.querySelector("input[name='displayMode']:checked")?.value ||
      "bilingual";
    overviewLanguage.textContent =
      Shared.TARGET_LANGUAGES[languageSelect.value] || languageSelect.value;
    overviewMode.textContent =
      selectedMode === "bilingual" ? "双语" : "仅译文";
    overviewModel.textContent = modelSelect.value.includes("flash")
      ? "DeepSeek V4 Flash"
      : "DeepSeek V4 Pro";
    overviewPrefetch.textContent = prefetchEnabledInput.checked
      ? "已启用"
      : "已关闭";
    overviewPrefetch.classList.toggle(
      "enabled-value",
      prefetchEnabledInput.checked
    );
    overviewDelay.textContent = `${delayInput.value} ms`;
  }

  function setConnectionStatus(message, kind = "") {
    const icon =
      kind === "error"
        ? "assets/icons/alert-circle.svg"
        : "assets/icons/circle-check.svg";
    connectionResult.innerHTML = `<img src="${icon}" alt="" />${message}`;
    connectionResult.classList.toggle("success", kind === "success");
    connectionResult.classList.toggle("error", kind === "error");
  }

  function handleResetDefaults() {
    populateForm(Shared.DEFAULT_SETTINGS);
    apiKeyInput.value = "";
    setStatus("已恢复默认值，点击保存后生效");
  }

  async function handleCopyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpointInput.value);
      setStatus("API 地址已复制", "success");
    } catch {
      endpointInput.select();
      document.execCommand("copy");
      setStatus("API 地址已复制", "success");
    }
  }

  function handlePreviewYouTube() {
    if (globalThis.chrome?.tabs?.create) {
      chrome.tabs.create({ url: "https://www.youtube.com/" });
      return;
    }
    window.open("https://www.youtube.com/", "_blank", "noopener");
  }

  function canUseExtensionRuntime() {
    return Boolean(globalThis.chrome?.runtime?.sendMessage);
  }

  function loadPreviewState() {
    hasStoredApiKey = true;
    maskedApiKey = "sk-f••••••584";
    populateForm(Shared.DEFAULT_SETTINGS);
    updateKeyState();
    setConnectionStatus("连接成功，可正常调用 API。", "success");
    lastTest.textContent = "上次测试：刚刚";
    setStatus("修改后请保存");
  }

  function sendMessage(message) {
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
})();
