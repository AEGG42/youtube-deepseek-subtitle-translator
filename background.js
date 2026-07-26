"use strict";

importScripts("shared.js", "translator-core.js", "word-lookup-core.js");

const Shared = globalThis.DeepSeekTranslatorShared;
const Core = globalThis.DeepSeekTranslatorCore;
const WordLookup = globalThis.DeepSeekWordLookupCore;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_LIMIT = 350;
const CAPTION_TRANSLATION_CACHE_LIMIT = 1500;
const CAPTION_TRANSLATION_CACHE_PREFIX = "caption-cache-v1:";
const WORD_LOOKUP_CACHE_LIMIT = 500;
const WORD_LOOKUP_CACHE_PREFIX = "word-lookup-cache-v1:";
const REQUEST_TIMEOUT_MS = 30_000;

const translationCache = new Map();
const inFlightRequests = new Map();
const activeTabRequests = new Map();
const activeCaptionBatchRequests = new Map();
const captionTrackCache = new Map();
const captionTranslationCache = new Map();
const wordLookupCache = new Map();
const wordLookupInFlight = new Map();
const dictionaryShardCache = new Map();
let captionTranslationCacheLoaded = false;
let captionTranslationCacheLoadPromise = null;
let wordLookupCacheLoaded = false;
let wordLookupCacheLoadPromise = null;

void restrictStorageToTrustedContexts();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await restrictStorageToTrustedContexts();
  const stored = await chrome.storage.local.get(null);
  const settings = Shared.sanitizeSettings(stored);

  await chrome.storage.local.set(settings);
  await updateActionBadge(settings);

  if (reason === "install" && !Shared.hasApiKey(settings)) {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await restrictStorageToTrustedContexts();
  const settings = await readSettings();
  await updateActionBadge(settings);
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.apiKey || changes.model || changes.targetLanguage) {
    abortAllActiveRequests();
    translationCache.clear();
    inFlightRequests.clear();
    wordLookupCache.clear();
    wordLookupInFlight.clear();
    await clearPersistedCaptionTranslationCache();
    await clearPersistedWordLookupCache();
  }

  const settings = await readSettings();
  await updateActionBadge(settings);
  await broadcastPublicSettings(settings);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "TRANSLATE_SUBTITLE") {
    handleTranslationMessage(message.payload, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "LOOKUP_WORD") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError(
            "UNTRUSTED_SENDER",
            "只接受来自 YouTube 页面中的查词请求"
          )
        )
      });
      return false;
    }

    lookupWord(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "CANCEL_TRANSLATION") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的请求")
        )
      });
      return false;
    }

    const activeRequest = activeTabRequests.get(sender.tab.id);
    if (
      activeRequest &&
      (message.requestId === undefined ||
        message.requestId === activeRequest.requestId)
    ) {
      activeRequest.controller.abort();
      activeTabRequests.delete(sender.tab.id);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "LOAD_YOUTUBE_CAPTIONS") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的请求")
        )
      });
      return false;
    }

    loadYouTubeCaptionTrack(sender.tab.id)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "TRANSLATE_CAPTION_BATCH") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的请求")
        )
      });
      return false;
    }

    translateCaptionBatch(message.payload, sender.tab.id)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "CANCEL_CAPTION_PREFETCH") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的请求")
        )
      });
      return false;
    }

    abortCaptionBatchRequests(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "TEST_DEEPSEEK_CONNECTION") {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "此操作只能从扩展设置页发起")
        )
      });
      return false;
    }
    testConnection()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "GET_EXTENSION_SETTINGS") {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "此操作只能从扩展页面发起")
        )
      });
      return false;
    }
    getSettingsSummary()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "GET_PUBLIC_SETTINGS") {
    if (!isYouTubeSender(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的请求")
        )
      });
      return false;
    }
    readSettings()
      .then((settings) =>
        sendResponse({
          ok: true,
          settings: Shared.toPublicSettings(settings)
        })
      )
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "SAVE_EXTENSION_SETTINGS") {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "此操作只能从扩展页面发起")
        )
      });
      return false;
    }
    saveSettings(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "SET_EXTENSION_ENABLED") {
    if (!isTrustedExtensionPage(sender)) {
      sendResponse({
        ok: false,
        error: serializeError(
          createCodedError("UNTRUSTED_SENDER", "此操作只能从扩展页面发起")
        )
      });
      return false;
    }
    setEnabled(message.enabled)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  return false;
});

async function handleTranslationMessage(payload, sender) {
  if (!isYouTubeSender(sender)) {
    throw createCodedError("UNTRUSTED_SENDER", "只接受来自 YouTube 页面的字幕");
  }

  const text = Core.cleanSubtitle(payload?.text);
  const requestId = Number.isSafeInteger(payload?.requestId)
    ? payload.requestId
    : 0;
  const tabId = sender.tab.id;
  const previousRequest = activeTabRequests.get(tabId);

  if (
    previousRequest &&
    (previousRequest.requestId !== requestId || payload?.force === true)
  ) {
    previousRequest.controller.abort();
  }

  const requestState = {
    controller: new AbortController(),
    requestId,
    text
  };
  activeTabRequests.set(tabId, requestState);

  try {
    const settings = await readSettings();
    return await translateSubtitle(payload, settings, {
      signal: requestState.controller.signal,
      onProgress: createProgressPublisher(tabId, requestId, text),
      skipCache: payload?.force === true
    });
  } finally {
    if (activeTabRequests.get(tabId) === requestState) {
      activeTabRequests.delete(tabId);
    }
  }
}

async function translateSubtitle(payload, settings, options = {}) {
  if (!settings.enabled && !options.ignoreEnabled) {
    throw createCodedError("DISABLED", "翻译已关闭");
  }

  if (!settings.apiKey) {
    throw createCodedError(
      "API_KEY_MISSING",
      "尚未配置 DeepSeek API Key，请打开扩展设置"
    );
  }

  const text = Core.cleanSubtitle(payload?.text);
  const context = Core.cleanContext(payload?.context);

  if (!text) {
    throw createCodedError("EMPTY_SUBTITLE", "字幕内容为空");
  }

  const requestDescriptor = {
    text,
    context,
    targetLanguage: settings.targetLanguage,
    model: settings.model
  };
  const cacheKey = Core.buildCacheKey(requestDescriptor);
  const cached = translationCache.get(cacheKey);

  if (!options.skipCache && cached && cached.expiresAt > Date.now()) {
    return {
      translation: cached.translation,
      cached: true,
      model: settings.model
    };
  }

  if (!options.skipCache && inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const requestPromise = requestDeepSeek({
    ...requestDescriptor,
    apiKey: settings.apiKey,
    signal: options.signal,
    onProgress: options.onProgress
  })
    .then((result) => {
      storeCache(cacheKey, result.translation);
      return { ...result, cached: false };
    })
    .finally(() => {
      if (inFlightRequests.get(cacheKey) === requestPromise) {
        inFlightRequests.delete(cacheKey);
      }
    });

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

async function lookupWord(payload) {
  const settings = await readSettings();
  if (!settings.enabled || !settings.wordLookupEnabled) {
    throw createCodedError("WORD_LOOKUP_DISABLED", "悬停查词已关闭");
  }

  const word = WordLookup.normalizeWord(payload?.word);
  if (!word) {
    throw createCodedError("INVALID_WORD", "请选择有效的英文单词");
  }

  if (settings.targetLanguage === "zh-CN") {
    const localResult = await lookupLocalDictionary(word);
    if (localResult) {
      return {
        ...localResult,
        cached: true,
        source: "dictionary"
      };
    }
  }

  if (!settings.wordLookupAiFallback) {
    throw createCodedError(
      "WORD_NOT_FOUND",
      "本地词典未收录，AI 补充已关闭"
    );
  }
  if (!settings.apiKey) {
    throw createCodedError(
      "API_KEY_MISSING",
      "本地词典未收录，且尚未配置 DeepSeek API Key"
    );
  }

  const descriptor = {
    word,
    sentence: String(payload?.sentence || ""),
    targetLanguage: settings.targetLanguage,
    model: settings.model
  };
  const cacheKey = WordLookup.buildLookupCacheKey(descriptor);
  await ensureWordLookupCacheLoaded();
  const cached = wordLookupCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) {
    return {
      ...cached.result,
      cached: true,
      source: "ai"
    };
  }
  if (cached) {
    wordLookupCache.delete(cacheKey);
  }

  if (wordLookupInFlight.has(cacheKey)) {
    return wordLookupInFlight.get(cacheKey);
  }

  const requestPromise = requestWordLookupFromDeepSeek({
    ...descriptor,
    translation: String(payload?.translation || ""),
    targetLanguageName:
      Shared.TARGET_LANGUAGES[settings.targetLanguage] ||
      settings.targetLanguage,
    apiKey: settings.apiKey
  })
    .then(async (result) => {
      const responseResult = {
        ...result.lookup,
        cached: false,
        source: "ai",
        model: result.model,
        usage: result.usage,
        latencyMs: result.latencyMs
      };
      const persisted = storeWordLookupCache(cacheKey, responseResult);
      await persistWordLookupCache(
        { [persisted.storageKey]: persisted.record },
        persisted.evictedStorageKeys
      );
      return responseResult;
    })
    .finally(() => {
      if (wordLookupInFlight.get(cacheKey) === requestPromise) {
        wordLookupInFlight.delete(cacheKey);
      }
    });

  wordLookupInFlight.set(cacheKey, requestPromise);
  return requestPromise;
}

async function lookupLocalDictionary(word) {
  const shardName = word[0];
  if (!/^[a-z]$/.test(shardName)) {
    return null;
  }

  let shardPromise = dictionaryShardCache.get(shardName);
  if (!shardPromise) {
    shardPromise = fetch(
      chrome.runtime.getURL(`assets/dictionary/${shardName}.json`)
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Dictionary shard ${shardName} is unavailable`);
        }
        return response.json();
      })
      .catch((error) => {
        dictionaryShardCache.delete(shardName);
        console.warn("Unable to load local dictionary shard", error);
        return {};
      });
    dictionaryShardCache.set(shardName, shardPromise);
  }

  const shard = await shardPromise;
  const entry = shard?.[word];
  if (!Array.isArray(entry) || !entry[1]) {
    return null;
  }
  return {
    word,
    lemma: WordLookup.normalizeWord(entry[2]) || word,
    phonetic: String(entry[0] || "").slice(0, 80),
    partOfSpeech: "",
    meaning: String(entry[1] || "").slice(0, 320)
  };
}

async function requestWordLookupFromDeepSeek({
  apiKey,
  word,
  sentence,
  translation,
  targetLanguage,
  targetLanguageName,
  model
}) {
  const body = WordLookup.buildWordLookupRequest({
    word,
    sentence,
    translation,
    targetLanguage,
    targetLanguageName,
    model
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  const startedAt = Date.now();

  try {
    const response = await fetch(Core.API_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const responseText = await response.text();
    const payload = parseJsonSafely(responseText);
    if (!response.ok) {
      const error = createCodedError(
        `HTTP_${response.status}`,
        Core.readableApiError(response.status, payload)
      );
      error.status = response.status;
      throw error;
    }

    return {
      lookup: WordLookup.extractWordLookup(payload, word),
      model: payload?.model || model,
      usage: normalizeUsage(payload?.usage),
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createCodedError("REQUEST_TIMEOUT", "DeepSeek 查词请求超时");
    }
    if (error instanceof TypeError) {
      throw createCodedError(
        "NETWORK_ERROR",
        "无法连接 DeepSeek，请检查网络或浏览器代理设置"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestDeepSeek({
  apiKey,
  text,
  context,
  targetLanguage,
  model,
  signal,
  onProgress
}) {
  const targetLanguageName =
    Shared.TARGET_LANGUAGES[targetLanguage] || targetLanguage;
  const useStreaming = typeof onProgress === "function";
  const body = Core.buildChatRequest({
    text,
    context,
    targetLanguage,
    targetLanguageName,
    model,
    stream: useStreaming
  });
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    const response = await fetch(Core.API_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: useStreaming ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const responseText = await response.text();
      const payload = parseJsonSafely(responseText);
      const error = createCodedError(
        `HTTP_${response.status}`,
        Core.readableApiError(response.status, payload)
      );
      error.status = response.status;
      throw error;
    }

    if (useStreaming) {
      const streamed = await readStreamedTranslation(response, onProgress);
      return {
        translation: streamed.translation,
        model: streamed.model || model,
        usage: normalizeUsage(streamed.usage),
        latencyMs: Date.now() - startedAt
      };
    }

    const responseText = await response.text();
    const payload = parseJsonSafely(responseText);
    return {
      translation: Core.extractTranslation(payload),
      model: payload?.model || model,
      usage: normalizeUsage(payload?.usage),
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      if (!timedOut && signal?.aborted) {
        throw createCodedError(
          "REQUEST_CANCELLED",
          "字幕已更新，旧翻译请求已取消"
        );
      }
      throw createCodedError(
        "REQUEST_TIMEOUT",
        "DeepSeek 请求超时，请检查网络后重试"
      );
    }
    if (error instanceof TypeError) {
      throw createCodedError(
        "NETWORK_ERROR",
        "无法连接 DeepSeek，请检查网络或浏览器代理设置"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

async function readStreamedTranslation(response, onProgress) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw createCodedError(
      "STREAM_UNAVAILABLE",
      "DeepSeek 未返回可读取的流式响应"
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let model = "";
  let usage = null;

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      return;
    }

    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      return;
    }

    const chunk = parseJsonSafely(data);
    if (chunk?.error) {
      throw createCodedError(
        "STREAM_ERROR",
        String(chunk.error?.message || chunk.error)
      );
    }

    model = chunk?.model || model;
    usage = chunk?.usage || usage;
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta !== "string" || !delta) {
      return;
    }

    content += delta;
    const partial = Core.cleanTranslationOutput(content);
    if (partial) {
      onProgress(partial);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(processLine);
  }

  if (buffer.trim()) {
    processLine(buffer);
  }

  const translation = Core.cleanTranslationOutput(content);
  if (!translation) {
    throw createCodedError("EMPTY_RESPONSE", "DeepSeek 返回了空内容");
  }

  onProgress(translation);
  return { translation, model, usage };
}

async function loadYouTubeCaptionTrack(tabId) {
  const metadata = await discoverYouTubeCaptionTrack(tabId);
  if (!metadata?.videoId || !metadata?.trackUrl) {
    throw createCodedError(
      "CAPTION_TRACK_UNAVAILABLE",
      "暂时无法取得当前视频的完整字幕轨"
    );
  }

  const timedTextUrl = normalizeTimedTextUrl(metadata.trackUrl);
  const cached = captionTrackCache.get(timedTextUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const response = await fetch(timedTextUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    const error = createCodedError(
      "CAPTION_DOWNLOAD_FAILED",
      `YouTube 字幕轨下载失败（HTTP ${response.status}）`
    );
    error.status = response.status;
    throw error;
  }

  const payload = parseJsonSafely(await response.text());
  const cues = parseTimedTextCues(payload);
  if (!cues.length) {
    throw createCodedError(
      "CAPTION_TRACK_EMPTY",
      "当前字幕轨没有可预翻译的时间码文本"
    );
  }

  const result = {
    videoId: metadata.videoId,
    languageCode: metadata.languageCode || "",
    trackName: metadata.trackName || "",
    isAutoGenerated: Boolean(metadata.isAutoGenerated),
    cues
  };

  while (captionTrackCache.size >= 5) {
    captionTrackCache.delete(captionTrackCache.keys().next().value);
  }
  captionTrackCache.set(timedTextUrl, {
    expiresAt: Date.now() + 30 * 60 * 1000,
    result
  });

  return result;
}

async function discoverYouTubeCaptionTrack(tabId) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const player = document.getElementById("movie_player");
      let playerResponse = null;
      let activeTrack = null;
      const parsePlayerResponse = (value) => {
        if (value && typeof value === "object") {
          return value;
        }
        if (typeof value !== "string" || !value) {
          return null;
        }
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      };

      try {
        playerResponse = parsePlayerResponse(
          player?.getPlayerResponse?.()
        );
      } catch {
        playerResponse = null;
      }
      playerResponse ||=
        parsePlayerResponse(globalThis.ytInitialPlayerResponse) ||
        parsePlayerResponse(globalThis.ytplayer?.config?.args?.player_response);
      try {
        activeTrack = player?.getOption?.("captions", "track") || null;
      } catch {
        activeTrack = null;
      }

      const videoId =
        playerResponse?.videoDetails?.videoId ||
        player?.getVideoData?.()?.video_id ||
        new URL(location.href).searchParams.get("v") ||
        "";
      const tracks =
        playerResponse?.captions?.playerCaptionsTracklistRenderer
          ?.captionTracks || [];
      const resourceUrls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => {
          if (!url.includes("/api/timedtext")) {
            return false;
          }
          try {
            const resource = new URL(url);
            const resourceVideoId = resource.searchParams.get("v");
            return (
              (!videoId && Boolean(resourceVideoId)) ||
              resourceVideoId === videoId
            );
          } catch {
            return false;
          }
        });
      const activeResourceUrl = resourceUrls.at(-1) || "";

      return {
        videoId,
        activeResourceUrl,
        activeLanguageCode:
          activeTrack?.languageCode || activeTrack?.lang || "",
        activeVssId: activeTrack?.vssId || "",
        tracks: tracks.map((track) => ({
          baseUrl: track?.baseUrl || "",
          languageCode: track?.languageCode || "",
          vssId: track?.vssId || "",
          kind: track?.kind || "",
          name:
            track?.name?.simpleText ||
            track?.name?.runs?.map((run) => run.text).join("") ||
            ""
        }))
      };
    }
  });

  const discovered = injectionResults?.[0]?.result;
  if (!discovered || typeof discovered !== "object") {
    throw createCodedError(
      "PLAYER_METADATA_UNAVAILABLE",
      "YouTube 播放器尚未准备好"
    );
  }

  const tracks = Array.isArray(discovered.tracks)
    ? discovered.tracks.filter((track) => track?.baseUrl)
    : [];
  let selectedTrack = null;
  let trackUrl = discovered.activeResourceUrl || "";

  if (trackUrl) {
    const resourceLanguage = getTimedTextLanguage(trackUrl);
    selectedTrack =
      tracks.find((track) => track.languageCode === resourceLanguage) || null;
  }
  if (!selectedTrack && discovered.activeVssId) {
    selectedTrack =
      tracks.find((track) => track.vssId === discovered.activeVssId) || null;
  }
  if (!selectedTrack && discovered.activeLanguageCode) {
    selectedTrack =
      tracks.find(
        (track) => track.languageCode === discovered.activeLanguageCode
      ) || null;
  }
  selectedTrack ||= tracks[0] || null;
  trackUrl ||= selectedTrack?.baseUrl || "";

  return {
    videoId: String(discovered.videoId || ""),
    trackUrl,
    languageCode:
      selectedTrack?.languageCode || getTimedTextLanguage(trackUrl),
    trackName: selectedTrack?.name || "",
    isAutoGenerated:
      selectedTrack?.kind === "asr" ||
      String(selectedTrack?.vssId || "").startsWith("a.")
  };
}

function normalizeTimedTextUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw createCodedError(
      "INVALID_CAPTION_URL",
      "YouTube 返回了无效的字幕轨地址"
    );
  }

  if (
    url.protocol !== "https:" ||
    !(url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) ||
    url.pathname !== "/api/timedtext"
  ) {
    throw createCodedError(
      "INVALID_CAPTION_URL",
      "字幕轨地址不是受信任的 YouTube 地址"
    );
  }

  url.searchParams.set("fmt", "json3");
  return url.toString();
}

function getTimedTextLanguage(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.searchParams.get("lang") || "";
  } catch {
    return "";
  }
}

function parseTimedTextCues(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const cues = [];

  events.forEach((event, eventIndex) => {
    if (!Array.isArray(event?.segs)) {
      return;
    }

    const text = Shared.normalizeWhitespace(
      event.segs
        .map((segment) =>
          typeof segment?.utf8 === "string" ? segment.utf8 : ""
        )
        .join("")
        .replace(/\n/g, " ")
    );
    const startMs = Number(event.tStartMs);
    const durationMs = Number(event.dDurationMs);
    if (!text || !Number.isFinite(startMs) || startMs < 0) {
      return;
    }

    const previous = cues.at(-1);
    const safeDuration =
      Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 2500;
    const endMs = startMs + safeDuration;
    if (
      previous &&
      previous.text === text &&
      startMs <= previous.endMs + 150
    ) {
      previous.endMs = Math.max(previous.endMs, endMs);
      return;
    }

    cues.push({
      id: `c${eventIndex}-${Math.round(startMs)}`,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text
    });
  });

  for (let index = 0; index < cues.length - 1; index += 1) {
    if (cues[index].endMs <= cues[index].startMs) {
      cues[index].endMs = Math.max(
        cues[index].startMs + 500,
        cues[index + 1].startMs
      );
    }
  }

  return cues.slice(0, 5000);
}

async function translateCaptionBatch(payload, tabId) {
  const settings = await readSettings();
  if (!settings.enabled) {
    throw createCodedError("DISABLED", "翻译已关闭");
  }
  if (!settings.apiKey) {
    throw createCodedError(
      "API_KEY_MISSING",
      "尚未配置 DeepSeek API Key，请打开扩展设置"
    );
  }

  const seenIds = new Set();
  const cues = (Array.isArray(payload?.cues) ? payload.cues : [])
    .slice(0, Core.MAX_BATCH_CUES)
    .map((cue) => ({
      id: String(cue?.id ?? "").slice(0, 80),
      text: Core.cleanSubtitle(
        cue?.text,
        Core.MAX_BATCH_CUE_LENGTH
      )
    }))
    .filter((cue) => {
      if (!cue.id || !cue.text || seenIds.has(cue.id)) {
        return false;
      }
      seenIds.add(cue.id);
      return true;
    });
  if (!cues.length) {
    throw createCodedError("EMPTY_SUBTITLE", "批量字幕内容为空");
  }

  const videoId = String(payload?.videoId || "").slice(0, 128);
  const context = Core.cleanBatchContext(payload?.context);
  await ensureCaptionTranslationCacheLoaded();
  const translationsById = new Map();
  const uncachedCues = [];
  for (const cue of cues) {
    const cacheKey = buildCaptionTranslationCacheKey(
      videoId,
      cue,
      settings
    );
    const cached = captionTranslationCache.get(cacheKey);
    if (cached?.expiresAt > Date.now()) {
      translationsById.set(cue.id, cached.translation);
      continue;
    }
    if (cached) {
      captionTranslationCache.delete(cacheKey);
    }
    uncachedCues.push({ ...cue, cacheKey });
  }

  const cacheHits = cues.length - uncachedCues.length;
  if (!uncachedCues.length) {
    return {
      translations: cues.map((cue) => ({
        id: cue.id,
        text: translationsById.get(cue.id)
      })),
      model: settings.model,
      usage: null,
      cached: true,
      cacheHits
    };
  }

  const expectedIds = uncachedCues.map((cue) => cue.id);
  const targetLanguageName =
    Shared.TARGET_LANGUAGES[settings.targetLanguage] ||
    settings.targetLanguage;
  const requestCues = cues.map((cue) => {
    const translation = translationsById.get(cue.id);
    return translation ? { ...cue, translation } : cue;
  });
  const body = Core.buildBatchChatRequest({
    cues: requestCues,
    targetIds: expectedIds,
    context,
    targetLanguage: settings.targetLanguage,
    targetLanguageName,
    model: settings.model
  });
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const tabRequests = activeCaptionBatchRequests.get(tabId) || new Set();
  tabRequests.add(controller);
  activeCaptionBatchRequests.set(tabId, tabRequests);

  try {
    const response = await fetch(Core.API_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const responseText = await response.text();
    const responsePayload = parseJsonSafely(responseText);

    if (!response.ok) {
      const error = createCodedError(
        `HTTP_${response.status}`,
        Core.readableApiError(response.status, responsePayload)
      );
      error.status = response.status;
      throw error;
    }

    const freshTranslations = Core.extractBatchTranslations(
      responsePayload,
      expectedIds
    );
    const uncachedById = new Map(
      uncachedCues.map((cue) => [cue.id, cue])
    );
    const storageUpdates = {};
    const storageRemovals = [];
    for (const translation of freshTranslations) {
      const cue = uncachedById.get(translation.id);
      if (!cue) {
        continue;
      }
      translationsById.set(translation.id, translation.text);
      const stored = storeCaptionTranslationCache(
        cue.cacheKey,
        translation.text
      );
      storageUpdates[stored.storageKey] = stored.record;
      storageRemovals.push(...stored.evictedStorageKeys);
    }
    await persistCaptionTranslationCache(
      storageUpdates,
      storageRemovals
    );

    return {
      translations: cues
        .filter((cue) => translationsById.has(cue.id))
        .map((cue) => ({
          id: cue.id,
          text: translationsById.get(cue.id)
        })),
      model: responsePayload?.model || settings.model,
      usage: normalizeUsage(responsePayload?.usage),
      cached: false,
      cacheHits
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      if (!timedOut) {
        throw createCodedError(
          "REQUEST_CANCELLED",
          "视频已切换，旧的整段字幕翻译已取消"
        );
      }
      throw createCodedError(
        "REQUEST_TIMEOUT",
        "整段字幕批量翻译超时，请稍后重试"
      );
    }
    if (error instanceof TypeError) {
      throw createCodedError(
        "NETWORK_ERROR",
        "无法连接 DeepSeek，请检查网络或浏览器代理设置"
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    tabRequests.delete(controller);
    if (!tabRequests.size) {
      activeCaptionBatchRequests.delete(tabId);
    }
  }
}

async function testConnection() {
  const settings = await readSettings();
  const result = await translateSubtitle(
    {
      text: "Connection successful.",
      context: []
    },
    settings,
    { ignoreEnabled: true, skipCache: true }
  );

  return {
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage
  };
}

async function getSettingsSummary() {
  const settings = await readSettings();
  return {
    settings: Shared.toPublicSettings(settings),
    hasApiKey: Shared.hasApiKey(settings),
    maskedApiKey: Shared.maskApiKey(settings.apiKey)
  };
}

async function saveSettings(payload) {
  const current = await readSettings();
  const candidate = {
    ...current,
    ...(payload && typeof payload === "object" ? payload : {})
  };

  if (payload?.apiKey === undefined) {
    candidate.apiKey = current.apiKey;
  }

  const settings = Shared.sanitizeSettings(candidate);
  await chrome.storage.local.set(settings);
  await updateActionBadge(settings);

  return {
    settings: Shared.toPublicSettings(settings),
    hasApiKey: Shared.hasApiKey(settings),
    maskedApiKey: Shared.maskApiKey(settings.apiKey)
  };
}

async function setEnabled(enabled) {
  if (typeof enabled !== "boolean") {
    throw createCodedError("INVALID_SETTING", "开关状态无效");
  }

  const current = await readSettings();
  const settings = Shared.sanitizeSettings({ ...current, enabled });
  if (!settings.enabled) {
    abortAllActiveRequests();
  }
  await chrome.storage.local.set({ enabled: settings.enabled });

  return {
    enabled: settings.enabled,
    hasApiKey: Shared.hasApiKey(settings)
  };
}

async function readSettings() {
  const stored = await chrome.storage.local.get(null);
  return Shared.sanitizeSettings(stored);
}

async function restrictStorageToTrustedContexts() {
  if (typeof chrome.storage.local.setAccessLevel !== "function") {
    return false;
  }

  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS"
    });
    return true;
  } catch (error) {
    console.error("Unable to restrict extension storage access", error);
    return false;
  }
}

async function broadcastPublicSettings(settings) {
  const tabs = await chrome.tabs.query({
    url: "https://www.youtube.com/*"
  });
  const message = {
    type: "PUBLIC_SETTINGS_UPDATED",
    settings: Shared.toPublicSettings(settings)
  };

  await Promise.all(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map(
        (tab) =>
          new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, message, () => {
              void chrome.runtime.lastError;
              resolve();
            });
          })
      )
  );
}

function createProgressPublisher(tabId, requestId, sourceText) {
  let lastPublished = "";

  return (translation) => {
    const normalized = Shared.normalizeWhitespace(translation);
    if (!normalized || normalized === lastPublished) {
      return;
    }
    lastPublished = normalized;

    chrome.tabs.sendMessage(
      tabId,
      {
        type: "TRANSLATION_PROGRESS",
        requestId,
        sourceText,
        translation: normalized
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  };
}

function abortAllActiveRequests() {
  for (const request of activeTabRequests.values()) {
    request.controller.abort();
  }
  activeTabRequests.clear();
  for (const requests of activeCaptionBatchRequests.values()) {
    for (const controller of requests) {
      controller.abort();
    }
  }
  activeCaptionBatchRequests.clear();
}

function abortCaptionBatchRequests(tabId) {
  const requests = activeCaptionBatchRequests.get(tabId);
  if (!requests) {
    return;
  }
  for (const controller of requests) {
    controller.abort();
  }
  activeCaptionBatchRequests.delete(tabId);
}

function storeCache(key, translation) {
  while (translationCache.size >= CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }

  translationCache.set(key, {
    translation,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function buildCaptionTranslationCacheKey(videoId, cue, settings) {
  return JSON.stringify([
    Core.TRANSLATION_PROMPT_VERSION,
    settings.model,
    settings.targetLanguage,
    videoId,
    cue.id,
    cue.text
  ]);
}

function storeCaptionTranslationCache(key, translation) {
  if (captionTranslationCache.has(key)) {
    captionTranslationCache.delete(key);
  }
  const evictedStorageKeys = [];
  const cacheLimit = getCaptionTranslationCacheLimit();
  while (
    captionTranslationCache.size >= cacheLimit
  ) {
    const oldestKey = captionTranslationCache.keys().next().value;
    const oldest = captionTranslationCache.get(oldestKey);
    if (oldest?.storageKey) {
      evictedStorageKeys.push(oldest.storageKey);
    }
    captionTranslationCache.delete(oldestKey);
  }
  const storageKey =
    CAPTION_TRANSLATION_CACHE_PREFIX + hashCacheKey(key);
  const record = {
    cacheKey: key,
    translation,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
  captionTranslationCache.set(key, {
    ...record,
    storageKey
  });
  return { storageKey, record, evictedStorageKeys };
}

function hashCacheKey(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function ensureCaptionTranslationCacheLoaded() {
  if (
    captionTranslationCacheLoaded ||
    !chrome.storage.session
  ) {
    return;
  }
  if (!captionTranslationCacheLoadPromise) {
    captionTranslationCacheLoadPromise = (async () => {
      const stored = await chrome.storage.session.get(null);
      const expiredStorageKeys = [];
      const now = Date.now();
      for (const [storageKey, record] of Object.entries(stored)) {
        if (!storageKey.startsWith(CAPTION_TRANSLATION_CACHE_PREFIX)) {
          continue;
        }
        if (
          typeof record?.cacheKey !== "string" ||
          typeof record?.translation !== "string" ||
          !record.translation ||
          Number(record.expiresAt) <= now
        ) {
          expiredStorageKeys.push(storageKey);
          continue;
        }
        captionTranslationCache.set(record.cacheKey, {
          cacheKey: record.cacheKey,
          translation: record.translation,
          expiresAt: Number(record.expiresAt),
          storageKey
        });
      }

      while (
        captionTranslationCache.size >
        getCaptionTranslationCacheLimit()
      ) {
        const oldestKey = captionTranslationCache.keys().next().value;
        const oldest = captionTranslationCache.get(oldestKey);
        if (oldest?.storageKey) {
          expiredStorageKeys.push(oldest.storageKey);
        }
        captionTranslationCache.delete(oldestKey);
      }
      if (expiredStorageKeys.length) {
        await chrome.storage.session.remove([
          ...new Set(expiredStorageKeys)
        ]);
      }
    })()
      .catch((error) => {
        console.warn("Unable to restore caption translation cache", error);
      })
      .finally(() => {
        captionTranslationCacheLoaded = true;
        captionTranslationCacheLoadPromise = null;
      });
  }
  await captionTranslationCacheLoadPromise;
}

function getCaptionTranslationCacheLimit() {
  const quotaBytes = Number(chrome.storage.session?.QUOTA_BYTES);
  return Number.isFinite(quotaBytes) && quotaBytes < 5_000_000
    ? Math.min(300, CAPTION_TRANSLATION_CACHE_LIMIT)
    : CAPTION_TRANSLATION_CACHE_LIMIT;
}

async function persistCaptionTranslationCache(updates, removals) {
  if (!chrome.storage.session) {
    return;
  }
  try {
    const updateKeys = new Set(Object.keys(updates));
    const uniqueRemovals = [...new Set(removals)].filter(
      (key) => !updateKeys.has(key)
    );
    if (uniqueRemovals.length) {
      await chrome.storage.session.remove(uniqueRemovals);
    }
    if (updateKeys.size) {
      await chrome.storage.session.set(updates);
    }
  } catch (error) {
    console.warn("Unable to persist caption translation cache", error);
  }
}

async function clearPersistedCaptionTranslationCache() {
  captionTranslationCache.clear();
  captionTranslationCacheLoaded = true;
  captionTranslationCacheLoadPromise = null;
  if (!chrome.storage.session) {
    return;
  }
  try {
    const stored = await chrome.storage.session.get(null);
    const keys = Object.keys(stored).filter((key) =>
      key.startsWith(CAPTION_TRANSLATION_CACHE_PREFIX)
    );
    if (keys.length) {
      await chrome.storage.session.remove(keys);
    }
  } catch (error) {
    console.warn("Unable to clear caption translation cache", error);
  }
}

function storeWordLookupCache(cacheKey, result) {
  if (wordLookupCache.has(cacheKey)) {
    wordLookupCache.delete(cacheKey);
  }
  const evictedStorageKeys = [];
  while (wordLookupCache.size >= WORD_LOOKUP_CACHE_LIMIT) {
    const oldestKey = wordLookupCache.keys().next().value;
    const oldest = wordLookupCache.get(oldestKey);
    if (oldest?.storageKey) {
      evictedStorageKeys.push(oldest.storageKey);
    }
    wordLookupCache.delete(oldestKey);
  }

  const storageKey = WORD_LOOKUP_CACHE_PREFIX + hashCacheKey(cacheKey);
  const record = {
    cacheKey,
    result,
    expiresAt: Date.now() + CACHE_TTL_MS
  };
  wordLookupCache.set(cacheKey, {
    ...record,
    storageKey
  });
  return { storageKey, record, evictedStorageKeys };
}

async function ensureWordLookupCacheLoaded() {
  if (wordLookupCacheLoaded || !chrome.storage.session) {
    return;
  }
  if (!wordLookupCacheLoadPromise) {
    wordLookupCacheLoadPromise = (async () => {
      const stored = await chrome.storage.session.get(null);
      const expiredStorageKeys = [];
      const now = Date.now();

      for (const [storageKey, record] of Object.entries(stored)) {
        if (!storageKey.startsWith(WORD_LOOKUP_CACHE_PREFIX)) {
          continue;
        }
        if (
          typeof record?.cacheKey !== "string" ||
          !record?.result?.meaning ||
          Number(record.expiresAt) <= now
        ) {
          expiredStorageKeys.push(storageKey);
          continue;
        }
        wordLookupCache.set(record.cacheKey, {
          cacheKey: record.cacheKey,
          result: record.result,
          expiresAt: Number(record.expiresAt),
          storageKey
        });
      }

      while (wordLookupCache.size > WORD_LOOKUP_CACHE_LIMIT) {
        const oldestKey = wordLookupCache.keys().next().value;
        const oldest = wordLookupCache.get(oldestKey);
        if (oldest?.storageKey) {
          expiredStorageKeys.push(oldest.storageKey);
        }
        wordLookupCache.delete(oldestKey);
      }
      if (expiredStorageKeys.length) {
        await chrome.storage.session.remove([
          ...new Set(expiredStorageKeys)
        ]);
      }
    })()
      .catch((error) => {
        console.warn("Unable to restore word lookup cache", error);
      })
      .finally(() => {
        wordLookupCacheLoaded = true;
        wordLookupCacheLoadPromise = null;
      });
  }
  await wordLookupCacheLoadPromise;
}

async function persistWordLookupCache(updates, removals) {
  if (!chrome.storage.session) {
    return;
  }
  try {
    const updateKeys = new Set(Object.keys(updates));
    const uniqueRemovals = [...new Set(removals)].filter(
      (key) => !updateKeys.has(key)
    );
    if (uniqueRemovals.length) {
      await chrome.storage.session.remove(uniqueRemovals);
    }
    if (updateKeys.size) {
      await chrome.storage.session.set(updates);
    }
  } catch (error) {
    console.warn("Unable to persist word lookup cache", error);
  }
}

async function clearPersistedWordLookupCache() {
  wordLookupCache.clear();
  wordLookupCacheLoaded = true;
  wordLookupCacheLoadPromise = null;
  if (!chrome.storage.session) {
    return;
  }
  try {
    const stored = await chrome.storage.session.get(null);
    const keys = Object.keys(stored).filter((key) =>
      key.startsWith(WORD_LOOKUP_CACHE_PREFIX)
    );
    if (keys.length) {
      await chrome.storage.session.remove(keys);
    }
  } catch (error) {
    console.warn("Unable to clear word lookup cache", error);
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return {
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0
  };
}

function parseJsonSafely(value) {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return { message: value.slice(0, 500) };
  }
}

function createCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTrustedExtensionPage(sender) {
  const extensionRoot = chrome.runtime.getURL("");
  return (
    sender?.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(extensionRoot)
  );
}

function isYouTubeSender(sender) {
  return (
    sender?.id === chrome.runtime.id &&
    typeof sender?.tab?.url === "string" &&
    sender.tab.url.startsWith("https://www.youtube.com/")
  );
}

function serializeError(error) {
  return {
    code: String(error?.code || "UNKNOWN_ERROR"),
    message: String(error?.message || "发生未知错误").slice(0, 300),
    status: Number.isInteger(error?.status) ? error.status : undefined
  };
}

async function updateActionBadge(settings) {
  if (!Shared.hasApiKey(settings)) {
    await chrome.action.setBadgeBackgroundColor({ color: "#FF0033" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({
      title: "YouTube DeepSeek 字幕翻译：需要配置 API Key"
    });
    return;
  }

  if (!settings.enabled) {
    await chrome.action.setBadgeBackgroundColor({ color: "#606060" });
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setTitle({
      title: "YouTube DeepSeek 字幕翻译：已关闭"
    });
    return;
  }

  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({
    title: "YouTube DeepSeek 字幕翻译"
  });
}
