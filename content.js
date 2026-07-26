(function initializeYouTubeTranslator() {
  "use strict";

  const Shared = globalThis.DeepSeekTranslatorShared;
  const WordLookup = globalThis.DeepSeekWordLookupCore;
  const CAPTION_SELECTOR =
    ".ytp-caption-window-container .ytp-caption-segment";
  const PLAYER_SELECTOR = ".html5-video-player";
  const OVERLAY_ID = "yt-deepseek-translator-overlay";
  const ACTIVE_PLAYER_CLASS = "yt-deepseek-translator-active";
  const HISTORY_LIMIT = 5;
  const INITIAL_REQUEST_DELAY_MS = 90;
  const LIVE_SEGMENT_SETTLE_MIN_MS = 420;
  const LIVE_SEGMENT_SETTLE_MAX_MS = 900;
  const OVERLAY_CLEAR_DELAY_MS = 950;
  const CAPTION_TRACK_LOAD_DELAY_MS = 350;
  const CAPTION_SEGMENT_GAP_MS = 850;
  const CAPTION_URGENT_BATCH_SIZE = 2;
  const CAPTION_URGENT_BATCH_MAX_CHARS = 600;
  const CAPTION_BACKGROUND_BATCH_SIZE = 18;
  const CAPTION_BACKGROUND_BATCH_MAX_CHARS = 2400;
  const CAPTION_PREFETCH_WORKERS = 2;
  const CAPTION_CONTEXT_SEGMENTS = 4;
  const CAPTION_DISPLAY_END_GRACE_MS = 180;
  const CAPTION_TRACK_RETRY_DELAYS_MS = [800, 1600, 3000, 5000];
  const WORD_LOOKUP_HOVER_DELAY_MS = 280;
  const CAPTION_SENTENCE_SEGMENTER =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "sentence" })
      : null;

  let settings = Shared.toPublicSettings(Shared.DEFAULT_SETTINGS);
  let observer = null;
  let observedMutationRoot = null;
  let readTimer = null;
  let clearTimer = null;
  let streamProgressRequestId = 0;
  let streamProgressReceivedForRequest = false;
  let completedStreamRequestId = 0;
  let lastObservedText = "";
  let pendingLiveCaptionText = "";
  let lastCommittedLiveCaptionText = "";
  let lastRequestedText = "";
  let lastTranslation = "";
  let translatedSourceText = "";
  let latestRequestId = 0;
  let recentCaptions = [];
  let recentTranslations = [];
  let isTranslating = false;
  let pendingCaptionUpdate = false;
  let forceRetranslatePending = false;
  let forcedSourceText = "";
  let forcedTranslationRequestId = 0;
  let lastError = null;
  let lastErrorAt = 0;
  let captionPrefetchGeneration = 0;
  let captionPrefetchTimer = null;
  let captionPrefetchStatus = "idle";
  let captionPrefetchError = null;
  let captionVideoId = "";
  let captionCues = [];
  let captionCueIndexById = new Map();
  let captionTranslations = new Map();
  let captionBatchQueue = [];
  let captionPrefetchFailed = false;
  let captionPrefetchRecoveryUsed = false;
  let boundVideo = null;
  let overlayResizeObserver = null;
  let observedOverlayPlayer = null;
  let observedOverlay = null;
  let wordLookupHoverTimer = null;
  let wordLookupRequestId = 0;
  let activeWordElement = null;
  let wordTooltipPinned = false;

  void start();

  async function start() {
    try {
      await loadSettings();
    } catch (error) {
      console.warn("YouTube DeepSeek Translator: settings unavailable", error);
    }
    observePage();
    bindRuntimeMessages();
    scheduleCaptionRead(0);
    scheduleCaptionTrackLoad();
  }

  async function loadSettings() {
    const response = await sendRuntimeMessage({
      type: "GET_PUBLIC_SETTINGS"
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message || "无法读取扩展设置");
    }

    settings = Shared.toPublicSettings(
      Shared.sanitizeSettings(response.settings)
    );
    applyVisualSettings();

    if (!settings.enabled) {
      resetCaptionState();
      resetCaptionPrefetch();
      removeOverlay();
    } else {
      scheduleCaptionRead(0);
      scheduleCaptionTrackLoad();
    }
  }

  function observePage() {
    bindMutationObserver();
    document.addEventListener("yt-navigate-finish", handleNavigation);
  }

  function bindMutationObserver() {
    if (observer) {
      observer.disconnect();
    }

    observedMutationRoot =
      document.querySelector(PLAYER_SELECTOR) || document.documentElement;
    observer = new MutationObserver(handleObservedMutations);
    observer.observe(observedMutationRoot, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function handleObservedMutations(mutations) {
    if (!settings.enabled) {
      return;
    }

    const captionChanged = mutations.some((mutation) => {
      if (mutation.type === "characterData") {
        return mutation.target?.parentElement?.closest?.(
          ".ytp-caption-window-container"
        );
      }

      return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => {
        if (!(node instanceof Element)) {
          return false;
        }
        return (
          node.matches?.(CAPTION_SELECTOR) ||
          node.querySelector?.(CAPTION_SELECTOR) ||
          node.matches?.(PLAYER_SELECTOR)
        );
      });
    });

    if (captionChanged) {
      const captionText = getCurrentCaptionText();
      if (captionText) {
        clearTimeout(clearTimer);
        clearTimer = null;
        pendingLiveCaptionText = captionText;
      }
      if (
        captionPrefetchFailed &&
        !captionPrefetchRecoveryUsed &&
        captionText
      ) {
        captionPrefetchRecoveryUsed = true;
        captionPrefetchFailed = false;
        captionPrefetchStatus = "idle";
        captionPrefetchError = null;
      }
      const shouldCommitSegment =
        captionTextHasCompleteSentence(captionText) ||
        (!captionText && Boolean(pendingLiveCaptionText));
      const captionReadDelay = shouldCommitSegment
        ? INITIAL_REQUEST_DELAY_MS
        : captionText
          ? undefined
          : 0;
      scheduleCaptionRead(captionReadDelay);
      scheduleCaptionTrackLoad();
    }

    if (
      observedMutationRoot === document.documentElement &&
      document.querySelector(PLAYER_SELECTOR)
    ) {
      bindMutationObserver();
    }
  }

  function bindRuntimeMessages() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GET_TRANSLATOR_STATUS") {
        sendResponse({
          ok: true,
          status: getStatus()
        });
        return false;
      }

      if (message?.type === "FORCE_RETRANSLATE") {
        const visibleCaptionText = getCurrentCaptionText();
        const prefetchedSource = visibleCaptionText
          ? findPrefetchedTranslation(visibleCaptionText)?.source || ""
          : "";
        const sourceText =
          prefetchedSource ||
          visibleCaptionText ||
          lastRequestedText ||
          translatedSourceText;
        cancelActiveTranslation();
        lastRequestedText = "";
        if (sourceText) {
          forceRetranslatePending = true;
          forcedSourceText = sourceText;
          scheduleCaptionRead(0);
        }
        sendResponse({ ok: true });
        return false;
      }

      if (message?.type === "TRANSLATION_PROGRESS") {
        handleTranslationProgress(message);
        return false;
      }

      if (message?.type === "PUBLIC_SETTINGS_UPDATED") {
        const nextSettings = Shared.toPublicSettings(
          Shared.sanitizeSettings(message.settings)
        );
        const targetLanguageChanged =
          nextSettings.targetLanguage !== settings.targetLanguage;
        const translationConfigChanged =
          targetLanguageChanged ||
          nextSettings.model !== settings.model;
        const prefetchConfigChanged =
          nextSettings.prefetchEnabled !== settings.prefetchEnabled;
        settings = nextSettings;
        applyVisualSettings();

        if (!settings.enabled) {
          resetCaptionState();
          resetCaptionPrefetch();
          removeOverlay();
        } else {
          if (translationConfigChanged || prefetchConfigChanged) {
            cancelActiveTranslation();
            latestRequestId += 1;
            lastRequestedText = "";
            translatedSourceText = "";
            lastError = null;
            if (targetLanguageChanged) {
              recentTranslations = [];
            }
            resetCaptionPrefetch();
          }
          scheduleCaptionRead(0);
          scheduleCaptionTrackLoad();
        }

        sendResponse({ ok: true });
        return false;
      }

      return false;
    });
  }

  function handleTranslationProgress(message) {
    const translation = Shared.normalizeWhitespace(message.translation);
    if (
      message.requestId !== latestRequestId ||
      message.requestId === completedStreamRequestId ||
      message.sourceText !== lastRequestedText ||
      !translation
    ) {
      return;
    }

    if (streamProgressRequestId !== message.requestId) {
      beginTranslationProgress(message.requestId);
    }

    if (streamProgressReceivedForRequest) {
      return;
    }

    streamProgressReceivedForRequest = true;
    lastError = null;
  }

  function beginTranslationProgress(requestId) {
    streamProgressRequestId = requestId;
    streamProgressReceivedForRequest = false;
    completedStreamRequestId = 0;
  }

  function finishTranslationProgress(requestId) {
    if (streamProgressRequestId === requestId) {
      streamProgressReceivedForRequest = false;
    }
    completedStreamRequestId = requestId;
  }

  function cancelQueuedTranslationProgress() {
    streamProgressRequestId = 0;
    streamProgressReceivedForRequest = false;
  }

  function handleNavigation() {
    resetCaptionState();
    resetCaptionPrefetch();
    removeOverlay();
    bindMutationObserver();
    scheduleCaptionRead(INITIAL_REQUEST_DELAY_MS);
    scheduleCaptionTrackLoad(CAPTION_TRACK_LOAD_DELAY_MS);
  }

  function scheduleCaptionRead(delay) {
    if (delay === 0) {
      clearTimeout(readTimer);
      readTimer = setTimeout(readCurrentCaption, 0);
      return;
    }

    if (Number.isFinite(delay)) {
      clearTimeout(readTimer);
      readTimer = setTimeout(readCurrentCaption, Math.max(0, Number(delay)));
      return;
    }

    const configuredDelay = Number(settings.translationDelay);
    const settleDelay = Math.min(
      LIVE_SEGMENT_SETTLE_MAX_MS,
      Math.max(
        LIVE_SEGMENT_SETTLE_MIN_MS,
        Number.isFinite(configuredDelay)
          ? configuredDelay
          : LIVE_SEGMENT_SETTLE_MIN_MS
      )
    );
    clearTimeout(readTimer);
    readTimer = setTimeout(readCurrentCaption, settleDelay);
  }

  function scheduleCaptionTrackLoad(
    delay = CAPTION_TRACK_LOAD_DELAY_MS,
    attempt = 0
  ) {
    if (
      !settings.enabled ||
      !settings.prefetchEnabled ||
      captionPrefetchTimer ||
      captionPrefetchFailed ||
      captionCues.length ||
      ["loading", "translating", "ready"].includes(captionPrefetchStatus)
    ) {
      return;
    }

    captionPrefetchTimer = setTimeout(() => {
      captionPrefetchTimer = null;
      void loadCaptionTrack(attempt);
    }, Math.max(0, Number(delay) || 0));
  }

  async function loadCaptionTrack(attempt) {
    if (!settings.enabled || !settings.prefetchEnabled) {
      return;
    }

    const generation = captionPrefetchGeneration;
    captionPrefetchStatus = attempt > 0 ? "retrying" : "loading";
    captionPrefetchError = null;

    try {
      const response = await sendRuntimeMessage({
        type: "LOAD_YOUTUBE_CAPTIONS"
      });
      if (generation !== captionPrefetchGeneration) {
        return;
      }
      if (!response?.ok) {
        const error = new Error(
          response?.error?.message || "无法获取当前视频的完整字幕"
        );
        error.code = response?.error?.code;
        throw error;
      }

      const cues = buildCaptionSegments(sanitizeCaptionCues(response.cues));
      if (!cues.length) {
        throw new Error("当前字幕轨没有可翻译的文本");
      }

      captionVideoId = String(response.videoId || "");
      captionCues = cues;
      captionCueIndexById = new Map(
        cues.map((cue, index) => [cue.id, index])
      );
      captionTranslations = new Map();
      captionBatchQueue = buildCaptionBatches(cues);
      captionPrefetchFailed = false;
      captionPrefetchStatus = captionBatchQueue.length
        ? "translating"
        : "ready";
      bindPrefetchVideo();
      renderPrefetchedAtPlaybackTime();
      void runCaptionPrefetchWorkers(generation);
    } catch (error) {
      if (generation !== captionPrefetchGeneration) {
        return;
      }

      captionPrefetchError = String(
        error?.message || "无法获取当前视频的完整字幕"
      );
      const retryDelay = CAPTION_TRACK_RETRY_DELAYS_MS[attempt];
      if (Number.isFinite(retryDelay)) {
        captionPrefetchStatus = "retrying";
        scheduleCaptionTrackLoad(retryDelay, attempt + 1);
        return;
      }

      captionPrefetchStatus = "unavailable";
      captionPrefetchFailed = true;
    }
  }

  function sanitizeCaptionCues(rawCues) {
    const ids = new Set();
    return (Array.isArray(rawCues) ? rawCues : [])
      .map((cue) => {
        const id = String(cue?.id || "");
        const startMs = Number(cue?.startMs);
        const endMs = Number(cue?.endMs);
        const text = Shared.normalizeWhitespace(cue?.text);
        if (
          !id ||
          ids.has(id) ||
          !text ||
          !Number.isFinite(startMs) ||
          !Number.isFinite(endMs) ||
          startMs < 0 ||
          endMs <= startMs
        ) {
          return null;
        }
        ids.add(id);
        return {
          id,
          startMs: Math.round(startMs),
          endMs: Math.round(endMs),
          text
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.startMs - right.startMs)
      .slice(0, 5000);
  }

  function buildCaptionSegments(cues) {
    const segments = [];
    let current = null;

    const flushCurrent = () => {
      if (!current?.text) {
        current = null;
        return;
      }
      appendSentenceCaptionSegments(segments, current);
      current = null;
    };

    for (const rawCue of cues) {
      const cue = trimRepeatedCompletedCaptionPrefix(
        rawCue,
        segments.at(-1)
      );
      if (!cue) {
        continue;
      }
      if (!current) {
        current = {
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text
        };
      } else {
        const gapMs = cue.startMs - current.endMs;
        const mergedText = mergeCaptionSegmentText(current.text, cue.text);

        if (gapMs >= CAPTION_SEGMENT_GAP_MS) {
          flushCurrent();
          current = {
            startMs: cue.startMs,
            endMs: cue.endMs,
            text: cue.text
          };
        } else {
          current.text = mergedText;
          current.endMs = Math.max(current.endMs, cue.endMs);
        }
      }

      if (captionSegmentIsComplete(current)) {
        flushCurrent();
      }
    }
    flushCurrent();

    for (let index = 0; index < segments.length - 1; index += 1) {
      const nextStartMs = segments[index + 1].startMs;
      if (segments[index].endMs >= nextStartMs) {
        segments[index].endMs = Math.max(
          segments[index].startMs + 250,
          nextStartMs - 1
        );
      }
    }

    return segments.slice(0, 5000);
  }

  function trimRepeatedCompletedCaptionPrefix(cue, previousSegment) {
    const currentText = Shared.normalizeWhitespace(cue?.text);
    const previousText = Shared.normalizeWhitespace(previousSegment?.text);
    if (
      !currentText ||
      !previousText ||
      !captionTextEndsSentence(previousText) ||
      !currentText.startsWith(previousText)
    ) {
      return cue;
    }

    const remainingText = Shared.normalizeWhitespace(
      currentText.slice(previousText.length)
    );
    if (!remainingText) {
      return null;
    }

    const durationMs = Math.max(1, cue.endMs - cue.startMs);
    const prefixRatio = Math.min(
      0.95,
      Array.from(previousText).length / Array.from(currentText).length
    );
    return {
      ...cue,
      startMs: Math.min(
        cue.endMs - 1,
        cue.startMs + Math.round(durationMs * prefixRatio)
      ),
      text: remainingText
    };
  }

  function captionSegmentIsComplete(segment) {
    return Boolean(segment?.text && captionTextEndsSentence(segment.text));
  }

  function appendSentenceCaptionSegments(segments, segment) {
    const sentences = splitCaptionTextIntoSentences(segment.text);
    const durationMs = Math.max(1, segment.endMs - segment.startMs);
    const weights = sentences.map((sentence) =>
      Math.max(1, Array.from(sentence).length)
    );
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    let consumedWeight = 0;

    for (let index = 0; index < sentences.length; index += 1) {
      const startMs =
        segment.startMs +
        Math.round((durationMs * consumedWeight) / totalWeight);
      consumedWeight += weights[index];
      const endMs =
        index === sentences.length - 1
          ? segment.endMs
          : segment.startMs +
            Math.round((durationMs * consumedWeight) / totalWeight);
      segments.push({
        id: `segment-${segments.length}-${startMs}`,
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        text: sentences[index]
      });
    }
  }

  function splitCaptionTextIntoSentences(text) {
    const normalized = Shared.normalizeWhitespace(text);
    if (!normalized) {
      return [];
    }

    if (CAPTION_SENTENCE_SEGMENTER) {
      const sentences = Array.from(
        CAPTION_SENTENCE_SEGMENTER.segment(normalized),
        ({ segment }) => Shared.normalizeWhitespace(segment)
      ).filter(Boolean);
      if (sentences.length) {
        return sentences;
      }
    }

    return (
      normalized.match(
        /.+?(?:[.!?。！？…]+["'”’）)\]】]*)(?=\s|$)|.+$/gu
      ) || [normalized]
    ).map((sentence) => Shared.normalizeWhitespace(sentence));
  }

  function captionTextHasCompleteSentence(text) {
    return splitCaptionTextIntoSentences(text).some((sentence) =>
      captionTextEndsSentence(sentence)
    );
  }

  function getNextLiveSentence(text) {
    const normalized = Shared.normalizeWhitespace(text);
    const sentences = splitCaptionTextIntoSentences(normalized);
    if (sentences.length > 1 && captionTextEndsSentence(sentences[0])) {
      return sentences[0];
    }
    return normalized;
  }

  function captionTextEndsSentence(text) {
    return /[.!?。！？…]["'”’）)\]】]*$/u.test(
      Shared.normalizeWhitespace(text)
    );
  }

  function mergeCaptionSegmentText(currentText, nextText) {
    const current = Shared.normalizeWhitespace(currentText);
    const next = Shared.normalizeWhitespace(nextText);
    if (!current) {
      return next;
    }
    if (!next || current === next || current.endsWith(next)) {
      return current;
    }
    if (next.startsWith(current)) {
      return next;
    }
    if (current.includes(next)) {
      return current;
    }
    if (next.includes(current)) {
      return next;
    }

    const comparableCurrent = current.toLocaleLowerCase();
    const comparableNext = next.toLocaleLowerCase();
    const maximumOverlap = Math.min(current.length, next.length);
    for (let overlap = maximumOverlap; overlap >= 4; overlap -= 1) {
      if (
        comparableCurrent.slice(-overlap) === comparableNext.slice(0, overlap)
      ) {
        return Shared.normalizeWhitespace(
          `${current}${next.slice(overlap)}`
        );
      }
    }

    const omitSpace =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(
        current
      ) &&
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(next);
    return Shared.normalizeWhitespace(`${current}${omitSpace ? "" : " "}${next}`);
  }

  function buildCaptionBatches(cues) {
    const playbackTimeMs = getPlaybackTimeMs();
    if (!Number.isFinite(playbackTimeMs)) {
      return createCaptionBatches(cues);
    }

    const foundCueIndex = cues.findIndex(
      (cue) => cue.endMs >= playbackTimeMs
    );
    const cueIndex =
      foundCueIndex >= 0 ? foundCueIndex : Math.max(0, cues.length - 1);
    const urgentCues = takeUrgentCaptionCues(cues.slice(cueIndex));
    const afterUrgent = cues.slice(cueIndex + urgentCues.length);
    const beforeUrgent = cues.slice(0, cueIndex);

    return [
      ...createUrgentCaptionBatches(urgentCues),
      ...createCaptionBatches(afterUrgent),
      ...createCaptionBatches(beforeUrgent)
    ].filter((batch) => batch.cues.length);
  }

  function createUrgentCaptionBatches(cues, attempt = 0) {
    return (Array.isArray(cues) ? cues : []).map((cue) => ({
      cues: [cue],
      attempt,
      urgent: true
    }));
  }

  function createCaptionBatches(
    cues,
    maxCues = CAPTION_BACKGROUND_BATCH_SIZE,
    maxCharacters = CAPTION_BACKGROUND_BATCH_MAX_CHARS,
    attempt = 0
  ) {
    const batches = [];
    let current = [];
    let characterCount = 0;

    for (const cue of cues) {
      const nextLength = cue.text.length;
      if (
        current.length &&
        (current.length >= maxCues ||
          characterCount + nextLength > maxCharacters)
      ) {
        batches.push({ cues: current, attempt });
        current = [];
        characterCount = 0;
      }
      current.push(cue);
      characterCount += nextLength;
    }
    if (current.length) {
      batches.push({ cues: current, attempt });
    }
    return batches;
  }

  function takeUrgentCaptionCues(cues) {
    const urgentCues = [];
    let characterCount = 0;
    for (const cue of cues) {
      if (
        urgentCues.length &&
        (urgentCues.length >= CAPTION_URGENT_BATCH_SIZE ||
          characterCount + cue.text.length >
            CAPTION_URGENT_BATCH_MAX_CHARS)
      ) {
        break;
      }
      urgentCues.push(cue);
      characterCount += cue.text.length;
    }
    return urgentCues;
  }

  function prioritizeCaptionBatchQueue(playbackTimeMs) {
    if (
      !Number.isFinite(playbackTimeMs) ||
      !captionBatchQueue.length
    ) {
      return;
    }

    const containingBatchIndex = captionBatchQueue.findIndex(
      (batch) =>
        batch.cues.some(
          (cue) =>
            cue.startMs <= playbackTimeMs + 220 &&
            cue.endMs >= playbackTimeMs - 180
        )
    );
    let urgentBatches = [];
    if (containingBatchIndex >= 0) {
      const [containingBatch] = captionBatchQueue.splice(
        containingBatchIndex,
        1
      );
      const foundCueIndex = containingBatch.cues.findIndex(
        (cue) => cue.endMs >= playbackTimeMs - 180
      );
      const cueIndex = Math.max(0, foundCueIndex);
      const urgentCues = takeUrgentCaptionCues(
        containingBatch.cues.slice(cueIndex)
      );
      const beforeUrgent = containingBatch.cues.slice(0, cueIndex);
      const afterUrgent = containingBatch.cues.slice(
        cueIndex + urgentCues.length
      );

      captionBatchQueue.push(
        ...createCaptionBatches(
          afterUrgent,
          CAPTION_BACKGROUND_BATCH_SIZE,
          CAPTION_BACKGROUND_BATCH_MAX_CHARS,
          containingBatch.attempt
        ),
        ...createCaptionBatches(
          beforeUrgent,
          CAPTION_BACKGROUND_BATCH_SIZE,
          CAPTION_BACKGROUND_BATCH_MAX_CHARS,
          containingBatch.attempt
        )
      );
      urgentBatches = createUrgentCaptionBatches(
        urgentCues,
        containingBatch.attempt
      );
    }

    captionBatchQueue.sort((left, right) => {
      const leftStart = left.cues[0]?.startMs ?? 0;
      const rightStart = right.cues[0]?.startMs ?? 0;
      const leftIsFuture = leftStart >= playbackTimeMs;
      const rightIsFuture = rightStart >= playbackTimeMs;
      if (leftIsFuture !== rightIsFuture) {
        return leftIsFuture ? -1 : 1;
      }
      return leftIsFuture
        ? leftStart - rightStart
        : rightStart - leftStart;
    });
    if (urgentBatches.length) {
      captionBatchQueue.unshift(...urgentBatches);
    }
  }

  async function runCaptionPrefetchWorkers(generation) {
    const workerCount = Math.min(
      CAPTION_PREFETCH_WORKERS,
      captionBatchQueue.length
    );
    await Promise.all(
      Array.from({ length: workerCount }, () =>
        runCaptionPrefetchWorker(generation)
      )
    );

    if (generation !== captionPrefetchGeneration) {
      return;
    }
    captionPrefetchStatus = captionPrefetchFailed ? "partial" : "ready";
    renderPrefetchedAtPlaybackTime();
  }

  async function runCaptionPrefetchWorker(generation) {
    while (
      generation === captionPrefetchGeneration &&
      captionBatchQueue.length
    ) {
      const batch = captionBatchQueue.shift();
      try {
        const context = getCaptionBatchContext(batch.cues);
        const response = await sendRuntimeMessage({
          type: "TRANSLATE_CAPTION_BATCH",
          payload: {
            videoId: captionVideoId,
            cues: batch.cues.map(({ id, text }) => ({ id, text })),
            context
          }
        });
        if (generation !== captionPrefetchGeneration) {
          return;
        }
        if (!response?.ok) {
          const error = new Error(
            response?.error?.message || "整段字幕批量翻译失败"
          );
          error.code = response?.error?.code;
          throw error;
        }

        const returnedIds = new Set();
        for (const item of Array.isArray(response.translations)
          ? response.translations
          : []) {
          const id = String(item?.id || "");
          const translation = Shared.normalizeWhitespace(item?.text);
          if (
            translation &&
            batch.cues.some((cue) => cue.id === id)
          ) {
            captionTranslations.set(id, translation);
            returnedIds.add(id);
          }
        }

        const missingCues = batch.cues.filter(
          (cue) => !returnedIds.has(cue.id)
        );
        if (missingCues.length && batch.attempt < 1) {
          captionBatchQueue.unshift(
            ...splitCaptionBatch(missingCues, batch.attempt + 1)
          );
        } else if (missingCues.length) {
          captionPrefetchFailed = true;
          captionPrefetchError = "部分字幕未返回翻译，播放时将实时补译";
        }

        renderPrefetchedAtPlaybackTime();
        scheduleCaptionRead(0);
      } catch (error) {
        if (generation !== captionPrefetchGeneration) {
          return;
        }

        captionPrefetchFailed = true;
        captionPrefetchError = String(
          error?.message || "整段字幕批量翻译失败"
        );
        if (error?.code && error.code !== "UNKNOWN_ERROR") {
          captionBatchQueue = [];
          return;
        }
        if (batch.attempt < 1 && batch.cues.length > 1) {
          captionBatchQueue.unshift(
            ...splitCaptionBatch(batch.cues, batch.attempt + 1)
          );
        }
      }
    }
  }

  function getCaptionBatchContext(batchCues) {
    const indexes = (Array.isArray(batchCues) ? batchCues : [])
      .map((batchCue) => captionCueIndexById.get(batchCue.id))
      .filter((index) => index >= 0);
    if (!indexes.length) {
      return { before: [], after: [] };
    }

    const firstIndex = Math.min(...indexes);
    const lastIndex = Math.max(...indexes);
    const toContextItem = (cue) => {
      const translation = captionTranslations.get(cue.id);
      return translation
        ? { source: cue.text, translation }
        : cue.text;
    };
    return {
      before: captionCues
        .slice(Math.max(0, firstIndex - CAPTION_CONTEXT_SEGMENTS), firstIndex)
        .map(toContextItem),
      after: captionCues
        .slice(lastIndex + 1, lastIndex + 1 + CAPTION_CONTEXT_SEGMENTS)
        .map(toContextItem)
    };
  }

  function splitCaptionBatch(cues, attempt) {
    if (cues.length <= 1) {
      return [{ cues, attempt }];
    }
    const middle = Math.ceil(cues.length / 2);
    return [
      { cues: cues.slice(0, middle), attempt },
      { cues: cues.slice(middle), attempt }
    ];
  }

  function bindPrefetchVideo() {
    const video =
      document.querySelector(`${PLAYER_SELECTOR} video`) ||
      document.querySelector("video.html5-main-video");
    if (video === boundVideo) {
      return;
    }

    unbindPrefetchVideo();
    boundVideo = video || null;
    boundVideo?.addEventListener("timeupdate", handlePlaybackPositionChange);
    boundVideo?.addEventListener("seeking", handlePlaybackPositionChange);
    boundVideo?.addEventListener("loadedmetadata", handlePlaybackPositionChange);
  }

  function unbindPrefetchVideo() {
    boundVideo?.removeEventListener(
      "timeupdate",
      handlePlaybackPositionChange
    );
    boundVideo?.removeEventListener("seeking", handlePlaybackPositionChange);
    boundVideo?.removeEventListener(
      "loadedmetadata",
      handlePlaybackPositionChange
    );
    boundVideo = null;
  }

  function handlePlaybackPositionChange(event) {
    if (event?.type === "seeking") {
      prioritizeCaptionBatchQueue(getPlaybackTimeMs());
    }
    if (!renderPrefetchedAtPlaybackTime()) {
      scheduleCaptionRead();
    }
  }

  function getPlaybackTimeMs() {
    bindPrefetchVideo();
    const currentTime = Number(boundVideo?.currentTime);
    return Number.isFinite(currentTime) ? currentTime * 1000 : NaN;
  }

  function isCueDisplayActive(cue, playbackTimeMs) {
    return (
      cue.startMs <= playbackTimeMs &&
      cue.endMs >= playbackTimeMs - CAPTION_DISPLAY_END_GRACE_MS
    );
  }

  function findPrefetchedTranslation(sourceText = "") {
    if (!captionCues.length || !captionTranslations.size) {
      return null;
    }

    const playbackTimeMs = getPlaybackTimeMs();
    if (!Number.isFinite(playbackTimeMs)) {
      return null;
    }

    const candidates = captionCues.filter(
      (cue) =>
        isCueDisplayActive(cue, playbackTimeMs) &&
        captionTranslations.has(cue.id)
    );
    if (!candidates.length) {
      return null;
    }

    const comparableSource = normalizeCaptionForMatch(sourceText);
    let selected = comparableSource
      ? candidates.filter((cue) =>
          captionsLikelyMatch(comparableSource, cue.text)
        )
      : [];

    if (!selected.length) {
      selected = [
        candidates.reduce((best, cue) => {
          const cueDistance = Math.abs(
            (cue.startMs + cue.endMs) / 2 - playbackTimeMs
          );
          const bestDistance = Math.abs(
            (best.startMs + best.endMs) / 2 - playbackTimeMs
          );
          return cueDistance < bestDistance ? cue : best;
        })
      ];
    }

    const sourceParts = [];
    const translationParts = [];
    for (const cue of selected) {
      if (sourceParts.at(-1) !== cue.text) {
        sourceParts.push(cue.text);
      }
      const translation = captionTranslations.get(cue.id);
      if (translation && translationParts.at(-1) !== translation) {
        translationParts.push(translation);
      }
    }

    const translation = Shared.normalizeWhitespace(
      translationParts.join(" ")
    );
    if (!translation) {
      return null;
    }
    return {
      source: Shared.normalizeWhitespace(sourceParts.join(" ")),
      translation
    };
  }

  function normalizeCaptionForMatch(value) {
    return Shared.normalizeWhitespace(value)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, "");
  }

  function captionsLikelyMatch(normalizedSource, cueText) {
    const normalizedCue = normalizeCaptionForMatch(cueText);
    if (!normalizedSource || !normalizedCue) {
      return false;
    }
    if (normalizedSource === normalizedCue) {
      return true;
    }

    const shorter =
      normalizedSource.length < normalizedCue.length
        ? normalizedSource
        : normalizedCue;
    const longer =
      normalizedSource.length < normalizedCue.length
        ? normalizedCue
        : normalizedSource;
    return (
      shorter.length >= 2 &&
      longer.includes(shorter) &&
      shorter.length / longer.length >= 0.45
    );
  }

  function tryRenderPrefetchedCaption(sourceText) {
    if (
      !settings.prefetchEnabled ||
      forceRetranslatePending ||
      forcedTranslationRequestId
    ) {
      return false;
    }
    const hit = findPrefetchedTranslation(sourceText);
    if (!hit) {
      return false;
    }

    applyPrefetchedTranslation(hit.source, hit.translation);
    return true;
  }

  function renderPrefetchedAtPlaybackTime() {
    if (
      !settings.enabled ||
      !settings.prefetchEnabled ||
      forceRetranslatePending ||
      forcedTranslationRequestId ||
      !captionTranslations.size
    ) {
      return false;
    }

    const visibleSource = getCurrentCaptionText();
    const hit = findPrefetchedTranslation(visibleSource);
    if (!hit) {
      return false;
    }

    clearTimeout(clearTimer);
    clearTimer = null;
    applyPrefetchedTranslation(hit.source, hit.translation);
    return true;
  }

  function applyPrefetchedTranslation(sourceText, translation) {
    const source = Shared.normalizeWhitespace(sourceText);
    if (!source || !translation) {
      return;
    }

    if (isTranslating) {
      cancelActiveTranslation();
      latestRequestId += 1;
    }
    lastObservedText = source;
    pendingLiveCaptionText = "";
    lastCommittedLiveCaptionText = "";
    lastRequestedText = source;
    lastTranslation = translation;
    translatedSourceText = source;
    pendingCaptionUpdate = false;
    isTranslating = false;
    lastError = null;
    rememberCaption(source);
    rememberTranslation(source, translation);
    renderCaption(source, translation, false);
  }

  function updateActivePrefetchedTranslation(sourceText, rawTranslation) {
    const translation = Shared.normalizeWhitespace(rawTranslation);
    const playbackTimeMs = getPlaybackTimeMs();
    if (
      !translation ||
      !captionCues.length ||
      !Number.isFinite(playbackTimeMs)
    ) {
      return;
    }

    const activeCues = captionCues.filter((cue) =>
      isCueDisplayActive(cue, playbackTimeMs)
    );
    if (!activeCues.length) {
      return;
    }

    const normalizedSource = normalizeCaptionForMatch(sourceText);
    let matchingCues = activeCues.filter((cue) =>
      captionsLikelyMatch(normalizedSource, cue.text)
    );
    if (!matchingCues.length) {
      matchingCues = [
        activeCues.reduce((best, cue) => {
          const cueDistance = Math.abs(
            (cue.startMs + cue.endMs) / 2 - playbackTimeMs
          );
          const bestDistance = Math.abs(
            (best.startMs + best.endMs) / 2 - playbackTimeMs
          );
          return cueDistance < bestDistance ? cue : best;
        })
      ];
    }

    for (const cue of matchingCues) {
      captionTranslations.set(cue.id, translation);
    }
  }

  function resetCaptionPrefetch() {
    const hadActivePrefetch =
      captionPrefetchStatus === "translating" ||
      captionPrefetchStatus === "loading";
    captionPrefetchGeneration += 1;
    clearTimeout(captionPrefetchTimer);
    captionPrefetchTimer = null;
    captionPrefetchStatus = "idle";
    captionPrefetchError = null;
    captionVideoId = "";
    captionCues = [];
    captionCueIndexById = new Map();
    captionTranslations = new Map();
    captionBatchQueue = [];
    captionPrefetchFailed = false;
    captionPrefetchRecoveryUsed = false;
    unbindPrefetchVideo();

    if (hadActivePrefetch) {
      chrome.runtime.sendMessage(
        { type: "CANCEL_CAPTION_PREFETCH" },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  }

  function readCurrentCaption() {
    readTimer = null;

    if (!settings.enabled) {
      removeOverlay();
      return;
    }

    const isForcedRequest = forceRetranslatePending;
    const visibleCaptionText = getCurrentCaptionText();
    const rawCaptionText = Shared.normalizeWhitespace(
      visibleCaptionText || pendingLiveCaptionText
    );
    const uncommittedLiveText = isForcedRequest
      ? ""
      : getUncommittedLiveCaptionText(rawCaptionText);
    const text = Shared.normalizeWhitespace(
      isForcedRequest
        ? forcedSourceText || rawCaptionText
        : getNextLiveSentence(uncommittedLiveText)
    );

    if (!rawCaptionText && !text) {
      if (renderPrefetchedAtPlaybackTime()) {
        return;
      }
      scheduleOverlayClear();
      return;
    }

    clearTimeout(clearTimer);
    clearTimer = null;

    if (!isForcedRequest && tryRenderPrefetchedCaption(rawCaptionText)) {
      pendingLiveCaptionText = "";
      return;
    }

    if (
      !isForcedRequest &&
      visibleCaptionText &&
      text &&
      !captionTextEndsSentence(text)
    ) {
      return;
    }

    if (!text) {
      pendingLiveCaptionText = "";
      return;
    }

    if (text === lastObservedText && text === lastRequestedText) {
      pendingLiveCaptionText = "";
      return;
    }

    lastObservedText = text;

    if (
      text !== lastRequestedText &&
      isTranslating &&
      lastRequestedText
    ) {
      pendingCaptionUpdate = true;
      return;
    }

    if (text === lastRequestedText) {
      pendingCaptionUpdate = false;
      pendingLiveCaptionText = "";
      const provisional = getRelatedProvisionalTranslation(text);
      renderCaption(
        text,
        provisional.translation,
        isTranslating,
        "",
        provisional.stale
      );
      return;
    }

    const context = getContextFor(text);
    rememberCaption(text);
    lastRequestedText = text;
    if (!isForcedRequest) {
      lastCommittedLiveCaptionText = getCommittedLiveCaptionText(
        rawCaptionText,
        uncommittedLiveText,
        text
      );
    }
    pendingLiveCaptionText = "";
    isTranslating = true;
    pendingCaptionUpdate = false;
    lastError = null;

    const requestId = ++latestRequestId;
    beginTranslationProgress(requestId);
    forceRetranslatePending = false;
    forcedSourceText = "";
    forcedTranslationRequestId = isForcedRequest ? requestId : 0;
    const provisional = getRelatedProvisionalTranslation(text);
    renderCaption(
      text,
      provisional.translation,
      true,
      "",
      provisional.stale
    );

    chrome.runtime.sendMessage(
      {
        type: "TRANSLATE_SUBTITLE",
        payload: {
          text,
          context,
          requestId,
          force: isForcedRequest
        }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          handleTranslationError(
            requestId,
            text,
            "扩展后台暂时不可用，请重新加载页面"
          );
          return;
        }

        if (requestId !== latestRequestId || text !== lastRequestedText) {
          return;
        }

        if (!response?.ok) {
          handleTranslationError(
            requestId,
            text,
            response?.error?.message || "翻译失败"
          );
          return;
        }

        finishTranslationProgress(requestId);
        isTranslating = false;
        if (forcedTranslationRequestId === requestId) {
          forcedTranslationRequestId = 0;
          updateActivePrefetchedTranslation(text, response.translation);
        }
        lastTranslation = Shared.normalizeWhitespace(response.translation);
        translatedSourceText = text;
        lastError = null;
        rememberTranslation(text, lastTranslation);
        renderCaption(text, lastTranslation, false);
        if (!getCurrentCaptionText()) {
          scheduleOverlayClear();
        }
        expeditePendingCaption();
      }
    );
  }

  function handleTranslationError(requestId, text, message) {
    if (requestId !== latestRequestId || text !== lastRequestedText) {
      return;
    }

    finishTranslationProgress(requestId);
    isTranslating = false;
    if (forcedTranslationRequestId === requestId) {
      forcedTranslationRequestId = 0;
    }
    if (
      translatedSourceText !== text &&
      !captionTextsAreRelated(text, translatedSourceText)
    ) {
      lastTranslation = "";
      translatedSourceText = "";
    }
    lastError = String(message || "翻译失败");
    lastErrorAt = Date.now();
    const provisional = getRelatedProvisionalTranslation(text);
    renderCaption(
      text,
      provisional.translation,
      false,
      lastError,
      provisional.stale
    );
    if (!getCurrentCaptionText()) {
      scheduleOverlayClear();
    }
    expeditePendingCaption();
  }

  function expeditePendingCaption(delay) {
    const currentText = getCurrentCaptionText() || pendingLiveCaptionText;
    if (!currentText || currentText === lastRequestedText) {
      return;
    }

    clearTimeout(readTimer);
    readTimer = null;
    scheduleCaptionRead(delay);
  }

  function getRelatedProvisionalTranslation(sourceText) {
    if (!lastTranslation || !translatedSourceText) {
      return { translation: "", stale: false };
    }
    if (translatedSourceText === sourceText) {
      return { translation: lastTranslation, stale: false };
    }
    if (captionTextsAreRelated(sourceText, translatedSourceText)) {
      return { translation: lastTranslation, stale: true };
    }
    return { translation: "", stale: false };
  }

  function getUncommittedLiveCaptionText(rawText) {
    const current = Shared.normalizeWhitespace(rawText);
    const committed = Shared.normalizeWhitespace(lastCommittedLiveCaptionText);
    if (!current || !committed) {
      return current;
    }
    if (
      current === committed ||
      committed.endsWith(current) ||
      committed.startsWith(current)
    ) {
      return "";
    }
    if (current.startsWith(committed)) {
      return Shared.normalizeWhitespace(current.slice(committed.length));
    }

    const comparableCurrent = current.toLocaleLowerCase();
    const comparableCommitted = committed.toLocaleLowerCase();
    const maximumOverlap = Math.min(current.length, committed.length);
    const usesCharacterBoundaries =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
        current
      );
    for (let overlap = maximumOverlap; overlap >= 4; overlap -= 1) {
      if (
        comparableCommitted.slice(-overlap) !==
        comparableCurrent.slice(0, overlap)
      ) {
        continue;
      }
      const committedBoundary =
        overlap === committed.length ||
        /[\s\p{P}\p{S}]/u.test(committed[committed.length - overlap - 1]);
      const currentBoundary =
        overlap === current.length ||
        /[\s\p{P}\p{S}]/u.test(current[overlap]);
      if (usesCharacterBoundaries || (committedBoundary && currentBoundary)) {
        return Shared.normalizeWhitespace(current.slice(overlap));
      }
    }

    return current;
  }

  function getCommittedLiveCaptionText(rawText, uncommittedText, committedText) {
    const raw = Shared.normalizeWhitespace(rawText);
    const uncommitted = Shared.normalizeWhitespace(uncommittedText);
    const committed = Shared.normalizeWhitespace(committedText);
    if (!raw || !committed || committed === uncommitted) {
      return raw;
    }

    const sentenceIndex = raw.indexOf(committed);
    if (sentenceIndex >= 0) {
      return Shared.normalizeWhitespace(
        raw.slice(0, sentenceIndex + committed.length)
      );
    }

    return mergeCaptionSegmentText(lastCommittedLiveCaptionText, committed);
  }

  function captionTextsAreRelated(firstText, secondText) {
    const normalizedFirst = normalizeCaptionForMatch(firstText);
    const normalizedSecond = normalizeCaptionForMatch(secondText);
    if (captionsLikelyMatch(normalizedFirst, normalizedSecond)) {
      return true;
    }

    const comparableLength = Math.min(
      normalizedFirst.length,
      normalizedSecond.length
    );
    let commonPrefixLength = 0;
    while (
      commonPrefixLength < comparableLength &&
      normalizedFirst[commonPrefixLength] === normalizedSecond[commonPrefixLength]
    ) {
      commonPrefixLength += 1;
    }

    const requiredPrefixLength = Math.min(
      8,
      Math.max(4, Math.ceil(comparableLength * 0.55))
    );
    return commonPrefixLength >= requiredPrefixLength;
  }

  function getCurrentCaptionText() {
    const player = document.querySelector(PLAYER_SELECTOR);
    if (!player) {
      return "";
    }

    const segments = Array.from(player.querySelectorAll(CAPTION_SELECTOR))
      .filter((element) => {
        const captionWindow = element.closest(".caption-window");
        return !captionWindow || captionWindow.style.display !== "none";
      })
      .map((element) => Shared.normalizeWhitespace(element.textContent))
      .filter(Boolean);

    const uniqueSegments = segments.filter(
      (segment, index) => index === 0 || segment !== segments[index - 1]
    );

    return Shared.normalizeWhitespace(uniqueSegments.join(" "));
  }

  function getContextFor(currentText) {
    const isUsefulContext = (caption) =>
      caption !== currentText &&
      !currentText.startsWith(caption) &&
      !caption.startsWith(currentText);
    const translationsBySource = new Map(
      recentTranslations.map((item) => [item.source, item])
    );
    return recentCaptions
      .filter(isUsefulContext)
      .slice(-CAPTION_CONTEXT_SEGMENTS)
      .map((caption) => translationsBySource.get(caption) || caption);
  }

  function rememberCaption(text) {
    const previous = recentCaptions.at(-1);

    if (previous && (text.startsWith(previous) || previous.startsWith(text))) {
      recentCaptions[recentCaptions.length - 1] = text;
    } else if (previous !== text) {
      recentCaptions.push(text);
    }

    if (recentCaptions.length > HISTORY_LIMIT) {
      recentCaptions = recentCaptions.slice(-HISTORY_LIMIT);
    }
  }

  function rememberTranslation(sourceText, translatedText) {
    const source = Shared.normalizeWhitespace(sourceText);
    const translation = Shared.normalizeWhitespace(translatedText);
    if (!source || !translation) {
      return;
    }

    recentTranslations = recentTranslations.filter(
      (item) => item.source !== source
    );
    recentTranslations.push({ source, translation });
    if (recentTranslations.length > HISTORY_LIMIT) {
      recentTranslations = recentTranslations.slice(-HISTORY_LIMIT);
    }
  }

  function renderCaption(
    source,
    translation,
    pending,
    errorMessage = "",
    stale = false
  ) {
    const overlay = ensureOverlay();
    if (!overlay) {
      return;
    }

    const sourceLine = overlay.querySelector("[data-role='source']");
    const translationLine = overlay.querySelector("[data-role='translation']");
    const statusLine = overlay.querySelector("[data-role='status']");
    const hasTranslation = Boolean(translation);

    if (overlay.dataset.mode !== settings.displayMode) {
      overlay.dataset.mode = settings.displayMode;
    }
    setClassState(overlay, "is-pending", pending);
    setClassState(overlay, "has-translation", hasTranslation);
    setClassState(overlay, "is-stale", stale);
    setClassState(overlay, "has-error", Boolean(errorMessage));

    renderSourceLine(sourceLine, source);
    setTextIfChanged(translationLine, translation);
    setHiddenIfChanged(translationLine, !hasTranslation);

    if (errorMessage) {
      setTextIfChanged(statusLine, shortenError(errorMessage));
      setHiddenIfChanged(statusLine, false);
    } else if (pending && !hasTranslation) {
      setTextIfChanged(statusLine, "DeepSeek 翻译中…");
      setHiddenIfChanged(statusLine, false);
    } else {
      setTextIfChanged(statusLine, "");
      setHiddenIfChanged(statusLine, true);
    }

    overlay.hidden = false;
    overlay
      .closest(PLAYER_SELECTOR)
      ?.classList.add(ACTIVE_PLAYER_CLASS);
  }

  function ensureOverlay() {
    const player = document.querySelector(PLAYER_SELECTOR);
    if (!player) {
      return null;
    }

    let overlay = player.querySelector(`#${OVERLAY_ID}`);
    if (overlay) {
      return overlay;
    }

    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = [
      '<div class="yt-dst-caption-card">',
      '<div class="yt-dst-line yt-dst-source" data-role="source"></div>',
      '<div class="yt-dst-line yt-dst-translation" data-role="translation" hidden></div>',
      "</div>",
      '<div class="yt-dst-word-tooltip" data-role="word-tooltip" role="tooltip" hidden>',
      '<div class="yt-dst-word-title" data-role="word-title"></div>',
      '<div class="yt-dst-word-meta" data-role="word-meta" hidden></div>',
      '<div class="yt-dst-word-meaning" data-role="word-meaning"></div>',
      "</div>",
      '<div class="yt-dst-status" data-role="status" hidden></div>'
    ].join("");

    player.appendChild(overlay);
    bindWordLookupEvents(overlay);
    applyVisualSettings(overlay);
    observeOverlaySize(player, overlay);
    return overlay;
  }

  function setTextIfChanged(element, value) {
    if (element.textContent !== value) {
      element.textContent = value;
    }
  }

  function renderSourceLine(element, value) {
    const interactive = Boolean(
      settings.wordLookupEnabled &&
        WordLookup &&
        typeof document.createTextNode === "function" &&
        typeof element?.replaceChildren === "function"
    );

    if (!interactive) {
      setTextIfChanged(element, value);
      return;
    }

    const renderMode = "interactive";
    if (
      element.dataset.sourceText === value &&
      element.dataset.renderMode === renderMode
    ) {
      return;
    }

    hideWordTooltip();
    const nodes = WordLookup.segmentEnglishText(value).map((segment) => {
      if (!segment.word) {
        return document.createTextNode(segment.text);
      }
      const word = document.createElement("span");
      word.className = "yt-dst-word";
      word.dataset.word = segment.word;
      word.textContent = segment.text;
      return word;
    });
    element.replaceChildren(...nodes);
    element.dataset.sourceText = value;
    element.dataset.renderMode = renderMode;
  }

  function bindWordLookupEvents(overlay) {
    const sourceLine = overlay.querySelector("[data-role='source']");
    if (
      !sourceLine ||
      typeof sourceLine.addEventListener !== "function"
    ) {
      return;
    }
    sourceLine.addEventListener("pointerover", handleWordPointerOver);
    sourceLine.addEventListener("pointerout", handleWordPointerOut);
    sourceLine.addEventListener("click", handleWordClick);
  }

  function handleWordPointerOver(event) {
    if (!settings.wordLookupEnabled) {
      return;
    }
    const wordElement = event.target?.closest?.(".yt-dst-word");
    if (!wordElement || wordElement === activeWordElement) {
      return;
    }
    wordTooltipPinned = false;
    activateWordTooltip(wordElement);
  }

  function handleWordPointerOut(event) {
    if (wordTooltipPinned) {
      return;
    }
    const wordElement = event.target?.closest?.(".yt-dst-word");
    if (!wordElement || wordElement !== activeWordElement) {
      return;
    }
    if (event.relatedTarget?.closest?.(".yt-dst-word") === wordElement) {
      return;
    }
    hideWordTooltip();
  }

  function handleWordClick(event) {
    const wordElement = event.target?.closest?.(".yt-dst-word");
    if (!settings.wordLookupEnabled || !wordElement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    if (activeWordElement === wordElement && wordTooltipPinned) {
      hideWordTooltip();
      return;
    }
    wordTooltipPinned = true;
    activateWordTooltip(wordElement, true);
  }

  function activateWordTooltip(wordElement, immediate = false) {
    clearTimeout(wordLookupHoverTimer);
    activeWordElement?.classList?.remove("is-active");
    activeWordElement = wordElement;
    wordElement.classList.add("is-active");
    const overlay = wordElement.closest(`#${OVERLAY_ID}`);
    const tooltip = overlay?.querySelector("[data-role='word-tooltip']");
    if (!tooltip) {
      return;
    }

    setTextIfChanged(
      tooltip.querySelector("[data-role='word-title']"),
      wordElement.textContent
    );
    setTextIfChanged(
      tooltip.querySelector("[data-role='word-meaning']"),
      "查询中…"
    );
    setHiddenIfChanged(
      tooltip.querySelector("[data-role='word-meta']"),
      true
    );
    setClassState(tooltip, "is-loading", true);
    tooltip.hidden = false;
    positionWordTooltip(overlay, tooltip, wordElement);

    wordLookupHoverTimer = setTimeout(
      () => void requestWordMeaning(wordElement),
      immediate ? 0 : WORD_LOOKUP_HOVER_DELAY_MS
    );
  }

  async function requestWordMeaning(wordElement) {
    if (activeWordElement !== wordElement) {
      return;
    }
    const requestId = ++wordLookupRequestId;
    const overlay = wordElement.closest(`#${OVERLAY_ID}`);
    const sourceLine = overlay?.querySelector("[data-role='source']");
    const translationLine = overlay?.querySelector(
      "[data-role='translation']"
    );

    try {
      const response = await sendRuntimeMessage({
        type: "LOOKUP_WORD",
        payload: {
          word: wordElement.dataset.word,
          sentence:
            sourceLine?.dataset?.sourceText || sourceLine?.textContent || "",
          translation: translationLine?.textContent || ""
        }
      });
      if (
        requestId !== wordLookupRequestId ||
        activeWordElement !== wordElement
      ) {
        return;
      }
      if (!response?.ok) {
        throw new Error(response?.error?.message || "无法查询词义");
      }
      renderWordTooltip(overlay, response);
    } catch (error) {
      if (
        requestId !== wordLookupRequestId ||
        activeWordElement !== wordElement
      ) {
        return;
      }
      renderWordTooltipError(overlay, error);
    }
  }

  function renderWordTooltip(overlay, result) {
    const tooltip = overlay?.querySelector("[data-role='word-tooltip']");
    if (!tooltip) {
      return;
    }
    const meta = [
      result.lemma && result.lemma !== result.word ? result.lemma : "",
      result.phonetic ? `/${result.phonetic}/` : "",
      result.partOfSpeech || ""
    ].filter(Boolean);

    setTextIfChanged(
      tooltip.querySelector("[data-role='word-meta']"),
      meta.join(" · ")
    );
    setHiddenIfChanged(
      tooltip.querySelector("[data-role='word-meta']"),
      meta.length === 0
    );
    setTextIfChanged(
      tooltip.querySelector("[data-role='word-meaning']"),
      result.meaning
    );
    setClassState(tooltip, "is-loading", false);
    setClassState(tooltip, "has-error", false);
  }

  function renderWordTooltipError(overlay, error) {
    const tooltip = overlay?.querySelector("[data-role='word-tooltip']");
    if (!tooltip) {
      return;
    }
    setTextIfChanged(
      tooltip.querySelector("[data-role='word-meaning']"),
      shortenError(error?.message || "无法查询词义")
    );
    setClassState(tooltip, "is-loading", false);
    setClassState(tooltip, "has-error", true);
  }

  function positionWordTooltip(overlay, tooltip, wordElement) {
    if (
      typeof overlay.getBoundingClientRect !== "function" ||
      typeof tooltip.getBoundingClientRect !== "function" ||
      typeof wordElement.getBoundingClientRect !== "function"
    ) {
      return;
    }
    const overlayRect = overlay.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const wordRect = wordElement.getBoundingClientRect();
    const desiredCenter =
      wordRect.left + wordRect.width / 2 - overlayRect.left;
    const halfWidth = Math.min(
      tooltipRect.width / 2,
      Math.max(0, overlayRect.width / 2 - 4)
    );
    const center = Math.max(
      halfWidth + 4,
      Math.min(overlayRect.width - halfWidth - 4, desiredCenter)
    );
    tooltip.style.setProperty("--yt-dst-tooltip-left", `${center}px`);
  }

  function hideWordTooltip() {
    clearTimeout(wordLookupHoverTimer);
    wordLookupHoverTimer = null;
    wordLookupRequestId += 1;
    wordTooltipPinned = false;
    activeWordElement?.classList?.remove("is-active");
    activeWordElement = null;
    const tooltip = document
      .getElementById(OVERLAY_ID)
      ?.querySelector("[data-role='word-tooltip']");
    if (tooltip) {
      tooltip.hidden = true;
      setClassState(tooltip, "is-loading", false);
      setClassState(tooltip, "has-error", false);
    }
  }

  function setHiddenIfChanged(element, hidden) {
    if (element.hidden !== hidden) {
      element.hidden = hidden;
    }
  }

  function setClassState(element, className, enabled) {
    if (element.classList.contains(className) !== enabled) {
      element.classList.toggle(className, enabled);
    }
  }

  function observeOverlaySize(player, overlay) {
    if (observedOverlayPlayer === player && observedOverlay === overlay) {
      return;
    }

    overlayResizeObserver?.disconnect();
    overlayResizeObserver = null;
    observedOverlayPlayer = player;
    observedOverlay = overlay;
    updateResponsiveFontSize(overlay, player.clientWidth);

    if (typeof ResizeObserver !== "function") {
      return;
    }

    overlayResizeObserver = new ResizeObserver((entries) => {
      const entry = entries.find((item) => item.target === player);
      if (!entry || observedOverlay !== overlay) {
        return;
      }
      updateResponsiveFontSize(overlay, entry.contentRect?.width);
    });
    overlayResizeObserver.observe(player);
  }

  function updateResponsiveFontSize(overlay, rawPlayerWidth) {
    const playerWidth = Number(rawPlayerWidth);
    let renderedFontSize = settings.fontSize;

    if (Number.isFinite(playerWidth) && playerWidth > 0) {
      const scale = Math.min(1, Math.max(0.75, playerWidth / 960));
      const playerSizeLimit = Math.max(20, playerWidth * 0.052);
      renderedFontSize = Math.max(
        16,
        Math.min(settings.fontSize * scale, playerSizeLimit)
      );
    }

    const cssValue = `${Math.round(renderedFontSize * 10) / 10}px`;
    if (overlay.dataset.renderFontSize === cssValue) {
      return;
    }
    overlay.dataset.renderFontSize = cssValue;
    overlay.style.setProperty("--yt-dst-render-font-size", cssValue);
  }

  function applyVisualSettings(existingOverlay) {
    const overlay =
      existingOverlay || document.getElementById(OVERLAY_ID);
    if (!overlay) {
      return;
    }

    overlay.style.setProperty("--yt-dst-font-size", `${settings.fontSize}px`);
    overlay.style.setProperty(
      "--yt-dst-background-opacity",
      String(settings.backgroundOpacity)
    );
    overlay.style.setProperty(
      "--yt-dst-subtitle-bottom",
      `${settings.subtitleBottom}%`
    );
    overlay.dataset.mode = settings.displayMode;
    overlay.dataset.wordLookup = settings.wordLookupEnabled
      ? "true"
      : "false";
    if (!settings.wordLookupEnabled) {
      hideWordTooltip();
    }
    updateResponsiveFontSize(
      overlay,
      overlay.closest(PLAYER_SELECTOR)?.clientWidth
    );
  }

  function scheduleOverlayClear() {
    if (clearTimer) {
      return;
    }

    clearTimer = setTimeout(() => {
      clearTimer = null;
      cancelActiveTranslation();
      lastObservedText = "";
      pendingLiveCaptionText = "";
      lastCommittedLiveCaptionText = "";
      lastRequestedText = "";
      lastTranslation = "";
      translatedSourceText = "";
      isTranslating = false;
      pendingCaptionUpdate = false;
      latestRequestId += 1;
      removeOverlay();
    }, OVERLAY_CLEAR_DELAY_MS);
  }

  function removeOverlay() {
    hideWordTooltip();
    overlayResizeObserver?.disconnect();
    overlayResizeObserver = null;
    observedOverlayPlayer = null;
    observedOverlay = null;
    document.getElementById(OVERLAY_ID)?.remove();
    document
      .querySelectorAll(`.${ACTIVE_PLAYER_CLASS}`)
      .forEach((player) => player.classList.remove(ACTIVE_PLAYER_CLASS));
  }

  function resetCaptionState() {
    cancelActiveTranslation();
    latestRequestId += 1;
    clearTimeout(readTimer);
    clearTimeout(clearTimer);
    readTimer = null;
    clearTimer = null;
    lastObservedText = "";
    pendingLiveCaptionText = "";
    lastCommittedLiveCaptionText = "";
    lastRequestedText = "";
    lastTranslation = "";
    translatedSourceText = "";
    recentCaptions = [];
    recentTranslations = [];
    isTranslating = false;
    pendingCaptionUpdate = false;
    forceRetranslatePending = false;
    forcedSourceText = "";
    forcedTranslationRequestId = 0;
    completedStreamRequestId = 0;
    lastError = null;
  }

  function shortenError(message) {
    const normalized = Shared.normalizeWhitespace(message);
    return normalized.length > 90 ? `${normalized.slice(0, 87)}…` : normalized;
  }

  function getStatus() {
    const playerFound = Boolean(document.querySelector(PLAYER_SELECTOR));
    const captionFound = Boolean(getCurrentCaptionText());
    const freshError =
      lastError && Date.now() - lastErrorAt < 60_000 ? lastError : null;

    return {
      enabled: settings.enabled,
      playerFound,
      captionFound,
      isTranslating,
      prefetchStatus: captionPrefetchStatus,
      prefetchTranslated: captionTranslations.size,
      prefetchTotal: captionCues.length,
      prefetchError: captionPrefetchError,
      hasTranslation: Boolean(
        lastTranslation && translatedSourceText === lastRequestedText
      ),
      error: freshError
    };
  }

  function cancelActiveTranslation() {
    cancelQueuedTranslationProgress();
    if (!isTranslating) {
      return;
    }

    const requestId = latestRequestId;
    completedStreamRequestId = requestId;
    chrome.runtime.sendMessage(
      {
        type: "CANCEL_TRANSLATION",
        requestId
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
    isTranslating = false;
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
})();
