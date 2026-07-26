"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay = 0) {
    const id = this.nextId++;
    this.tasks.set(id, {
      at: this.now + Math.max(0, Number(delay) || 0),
      callback
    });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  tick(milliseconds) {
    const target = this.now + milliseconds;

    while (true) {
      let nextId = null;
      let nextTask = null;

      for (const [id, task] of this.tasks) {
        if (
          task.at <= target &&
          (!nextTask || task.at < nextTask.at || (task.at === nextTask.at && id < nextId))
        ) {
          nextId = id;
          nextTask = task;
        }
      }

      if (!nextTask) {
        break;
      }

      this.now = nextTask.at;
      this.tasks.delete(nextId);
      nextTask.callback();
    }

    this.now = target;
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  toggle(value, force) {
    if (force === undefined ? !this.values.has(value) : force) {
      this.values.add(value);
      return true;
    }
    this.values.delete(value);
    return false;
  }

  contains(value) {
    return this.values.has(value);
  }
}

class FakeStyle {
  constructor(onWrite = () => {}) {
    this.values = new Map();
    this.onWrite = onWrite;
  }

  setProperty(name, value) {
    this.onWrite(name, value);
    this.values.set(name, value);
  }

  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
}

async function createContentHarness({
  deferTranslations = false,
  deferBatches = false,
  batchResponseDelayPerCueMs = 0,
  batchError = null,
  prefetchEnabled = false,
  captionTrack = null,
  captionTrackResponses = null,
  currentTime = 0,
  playerWidth = 1280
} = {}) {
  const clock = new FakeClock();
  const requests = [];
  const batchRequests = [];
  const captionTrackRequests = [];
  const pendingTranslationCallbacks = [];
  const pendingBatchCallbacks = [];
  const runtimeListeners = [];
  let observerCallback = null;
  let observerTarget = null;
  let observerOptions = null;
  let resizeObserverCallback = null;
  let resizeObserverTarget = null;
  let captionTrackResponseIndex = 0;
  let caption = "";
  let overlay = null;
  let overlayLines = null;
  const renderWrites = {
    source: 0,
    translation: 0,
    status: 0,
    style: 0
  };
  const videoListeners = new Map();

  const video = {
    currentTime,
    addEventListener(type, listener) {
      const listeners = videoListeners.get(type) || new Set();
      listeners.add(listener);
      videoListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      videoListeners.get(type)?.delete(listener);
    }
  };

  const player = {
    classList: new FakeClassList(),
    clientWidth: playerWidth,
    querySelector(selector) {
      return selector.startsWith("#yt-deepseek") ? overlay : null;
    },
    querySelectorAll() {
      if (!caption) {
        return [];
      }
      return [
        {
          textContent: caption,
          closest() {
            return { style: {} };
          }
        }
      ];
    },
    appendChild(element) {
      overlay = element;
      element.player = player;
    }
  };

  function createOverlay() {
    function createLine(role, hidden) {
      let textContent = "";
      return {
        hidden,
        get textContent() {
          return textContent;
        },
        set textContent(value) {
          renderWrites[role] += 1;
          textContent = value;
        }
      };
    }

    const lines = {
      source: createLine("source", false),
      translation: createLine("translation", true),
      status: createLine("status", true)
    };
    overlayLines = lines;

    return {
      id: "",
      hidden: false,
      dataset: {},
      style: new FakeStyle(() => {
        renderWrites.style += 1;
      }),
      classList: new FakeClassList(),
      setAttribute() {},
      set innerHTML(_value) {},
      querySelector(selector) {
        const role = selector.match(/data-role='([^']+)'/)?.[1];
        return lines[role] || null;
      },
      closest() {
        return player;
      },
      remove() {
        overlay = null;
      }
    };
  }

  class FakeElement {}

  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }

    observe(target, options) {
      observerTarget = target;
      observerOptions = options;
    }

    disconnect() {}
  }

  class FakeResizeObserver {
    constructor(callback) {
      resizeObserverCallback = callback;
    }

    observe(target) {
      resizeObserverTarget = target;
    }

    disconnect() {
      resizeObserverTarget = null;
    }
  }

  const document = {
    documentElement: {},
    querySelector(selector) {
      if (selector === ".html5-video-player") {
        return player;
      }
      if (
        selector === ".html5-video-player video" ||
        selector === "video.html5-main-video"
      ) {
        return video;
      }
      return null;
    },
    querySelectorAll() {
      return player.classList.contains("yt-deepseek-translator-active")
        ? [player]
        : [];
    },
    getElementById() {
      return overlay;
    },
    createElement() {
      return createOverlay();
    },
    addEventListener() {}
  };

  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        if (message.type === "GET_PUBLIC_SETTINGS") {
          callback({
            ok: true,
            settings: {
              enabled: true,
              prefetchEnabled,
              targetLanguage: "zh-CN",
              model: "deepseek-v4-flash",
              displayMode: "bilingual",
              fontSize: 30,
              backgroundOpacity: 0.62,
              subtitleBottom: 12,
              translationDelay: 420
            }
          });
          return;
        }

        if (message.type === "LOAD_YOUTUBE_CAPTIONS") {
          captionTrackRequests.push({ at: clock.now });
          const configuredTrack = Array.isArray(captionTrackResponses)
            ? captionTrackResponses[
                Math.min(
                  captionTrackResponseIndex++,
                  captionTrackResponses.length - 1
                )
              ]
            : captionTrack;
          callback(
            configuredTrack
              ? { ok: true, ...configuredTrack }
              : {
                  ok: false,
                  error: {
                    code: "CAPTION_TRACK_UNAVAILABLE",
                    message: "No caption track"
                  }
                }
          );
          return;
        }

        if (message.type === "TRANSLATE_CAPTION_BATCH") {
          batchRequests.push({
            at: clock.now,
            payload: message.payload
          });
          const response = {
            ok: true,
            translations: message.payload.cues.map((cue) => ({
              id: cue.id,
              text: `batch:${cue.text}`
            }))
          };
          if (batchError) {
            callback({ ok: false, error: batchError });
            return;
          }
          if (batchResponseDelayPerCueMs > 0) {
            clock.setTimeout(
              () => callback(response),
              message.payload.cues.length * batchResponseDelayPerCueMs
            );
            return;
          }
          if (deferBatches) {
            pendingBatchCallbacks.push(() => callback(response));
            return;
          }
          callback(response);
          return;
        }

        if (
          message.type === "CANCEL_TRANSLATION" ||
          message.type === "CANCEL_CAPTION_PREFETCH"
        ) {
          callback?.({ ok: true });
          return;
        }

        if (message.type === "TRANSLATE_SUBTITLE") {
          requests.push({
            at: clock.now,
            payload: message.payload
          });
          if (deferTranslations) {
            pendingTranslationCallbacks.push(callback);
            return;
          }
          callback({
            ok: true,
            translation: `译文：${message.payload.text}`
          });
        }
      }
    }
  };

  const context = vm.createContext({
    Element: FakeElement,
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    chrome,
    clearTimeout: clock.clearTimeout.bind(clock),
    console,
    document,
    setTimeout: clock.setTimeout.bind(clock)
  });
  context.globalThis = context;
  context.self = context;

  for (const file of ["shared.js", "content.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
      filename: file
    });
  }

  await new Promise((resolve) => setImmediate(resolve));
  clock.tick(0);

  return {
    clock,
    requests,
    batchRequests,
    captionTrackRequests,
    dispatchContentMessage(message) {
      let response;
      for (const listener of runtimeListeners) {
        listener(message, {}, (value) => {
          response = value;
        });
      }
      return response;
    },
    completeBatch(index) {
      pendingBatchCallbacks[index]?.();
    },
    completeRequest(index, translation) {
      pendingTranslationCallbacks[index]?.({
        ok: true,
        translation
      });
    },
    publishProgress(index, translation) {
      const request = requests[index];
      for (const listener of runtimeListeners) {
        listener(
          {
            type: "TRANSLATION_PROGRESS",
            requestId: request.payload.requestId,
            sourceText: request.payload.text,
            translation
          },
          {},
          () => {}
        );
      }
    },
    getOverlayState() {
      return {
        visible: Boolean(overlay) && !overlay.hidden,
        source: overlayLines?.source.textContent || "",
        translation: overlayLines?.translation.textContent || "",
        statusHidden: overlayLines?.status.hidden ?? true,
        stale: overlay?.classList.contains("is-stale") || false
      };
    },
    getRenderWrites() {
      return { ...renderWrites };
    },
    getOverlayStyle(name) {
      return overlay?.style.getPropertyValue(name) || "";
    },
    resizePlayer(width) {
      player.clientWidth = width;
      if (resizeObserverCallback && resizeObserverTarget === player) {
        resizeObserverCallback([
          {
            target: player,
            contentRect: { width }
          }
        ]);
      }
    },
    setCaption(value) {
      caption = value;
      observerCallback([
        {
          type: "characterData",
          target: {
            parentElement: {
              closest() {
                return {};
              }
            }
          }
        }
      ]);
    },
    setCurrentTime(value, eventType = "timeupdate") {
      video.currentTime = value;
      for (const listener of videoListeners.get(eventType) || []) {
        listener({ type: eventType });
      }
    },
    getObserverState() {
      return {
        target: observerTarget,
        options: observerOptions,
        player,
        documentElement: document.documentElement
      };
    }
  };
}

test("continuous automatic-caption mutations wait for one stable segment", async () => {
  const harness = await createContentHarness();
  const words = [];

  for (let index = 1; index <= 10; index += 1) {
    harness.clock.tick(100);
    words.push(`word${index}`);
    harness.setCaption(words.join(" "));
  }

  assert.equal(
    harness.requests.length,
    0,
    "a continuously growing caption must not send fragment requests"
  );

  harness.clock.tick(419);
  assert.equal(harness.requests.length, 0);
  harness.clock.tick(1);

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].payload.text, words.join(" "));
});

test("continuous speech commits bounded segments without a request flood", async () => {
  const harness = await createContentHarness({ deferTranslations: true });
  const words = [];

  for (let index = 1; index <= 40; index += 1) {
    harness.clock.tick(100);
    words.push(`word${index}`);
    harness.setCaption(words.join(" "));
  }

  assert.ok(harness.requests.length >= 1);
  assert.ok(
    harness.requests.length <= 2,
    `expected at most 2 bounded-segment requests, got ${harness.requests.length}`
  );
  assert.ok(harness.requests[0].at <= 2900);
  assert.match(harness.requests[0].payload.text, /word28/);
});

test("sentence-ending punctuation commits a live segment quickly", async () => {
  const harness = await createContentHarness();

  harness.clock.tick(100);
  harness.setCaption("This is one complete thought.");
  harness.clock.tick(89);
  assert.equal(harness.requests.length, 0);
  harness.clock.tick(1);

  assert.equal(harness.requests.length, 1);
  assert.equal(
    harness.requests[0].payload.text,
    "This is one complete thought."
  );
});

test("a disappearing caption commits the last accumulated live segment", async () => {
  const harness = await createContentHarness();

  harness.clock.tick(100);
  harness.setCaption("A complete thought without punctuation");
  harness.clock.tick(200);
  assert.equal(harness.requests.length, 0);

  harness.setCaption("");
  harness.clock.tick(90);

  assert.equal(harness.requests.length, 1);
  assert.equal(
    harness.requests[0].payload.text,
    "A complete thought without punctuation"
  );
});

test("live segments translate only the uncommitted cumulative suffix", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("one two three");
  harness.clock.tick(420);
  assert.equal(harness.requests[0].payload.text, "one two three");
  harness.completeRequest(0, "一二三");

  harness.setCaption("one two three four five six");
  harness.clock.tick(420);

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].payload.text, "four five six");
});

test("live segments remove overlap when the caption window rolls forward", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("one two three four");
  harness.clock.tick(420);
  harness.completeRequest(0, "一二三四");

  harness.setCaption("three four five six");
  harness.clock.tick(420);

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].payload.text, "five six");
});

test("live segments carry the previous completed bilingual context", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("The project is called Aurora.");
  harness.clock.tick(90);
  harness.completeRequest(0, "这个项目名为‘极光’。");

  harness.setCaption("It will launch next spring.");
  harness.clock.tick(90);

  assert.equal(harness.requests.length, 2);
  assert.equal(
    harness.requests[1].payload.context[0].source,
    "The project is called Aurora."
  );
  assert.equal(
    harness.requests[1].payload.context[0].translation,
    "这个项目名为‘极光’。"
  );
});

test("live bilingual context stays in transcript order", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Aurora is our internal codename.");
  harness.clock.tick(90);
  harness.completeRequest(0, "‘极光’是我们的内部代号。");
  harness.setCaption("The team approved it yesterday.");
  harness.clock.tick(90);
  harness.completeRequest(1, "团队昨天批准了它。");
  harness.setCaption("It will be announced next spring.");
  harness.clock.tick(90);

  assert.deepEqual(
    Array.from(harness.requests[2].payload.context, (item) => item.source),
    ["Aurora is our internal codename.", "The team approved it yesterday."]
  );
});

test("changing target language drops old translated context", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Aurora is ready.");
  harness.clock.tick(90);
  harness.completeRequest(0, "‘极光’已准备就绪。");
  harness.dispatchContentMessage({
    type: "PUBLIC_SETTINGS_UPDATED",
    settings: {
      enabled: true,
      prefetchEnabled: false,
      targetLanguage: "ja",
      model: "deepseek-v4-flash",
      displayMode: "bilingual",
      fontSize: 30,
      backgroundOpacity: 0.62,
      subtitleBottom: 12,
      translationDelay: 420
    }
  });
  harness.setCaption("It launches tomorrow.");
  harness.clock.tick(90);

  assert.equal(harness.requests.length, 2);
  assert.equal(
    harness.requests[1].payload.context[0],
    "Aurora is ready.",
    "source context remains useful, but the confirmed Chinese translation must not leak into Japanese"
  );
});

test("streaming fragments stay hidden until the final API response", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Hello world.");
  harness.clock.tick(90);

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.getOverlayState().translation, "");

  harness.publishProgress(0, "你");
  harness.publishProgress(0, "你好");
  harness.clock.tick(200);

  assert.equal(
    harness.getOverlayState().translation,
    "",
    "an incomplete streamed phrase must not be shown as finished subtitles"
  );
  assert.equal(harness.getOverlayState().statusHidden, false);

  harness.completeRequest(0, "你好，世界");

  assert.equal(harness.getOverlayState().translation, "你好，世界");
  assert.equal(harness.getOverlayState().statusHidden, true);
});

test("a burst of streamed tokens does not paint incomplete subtitles", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("A steadily growing translation.");
  harness.clock.tick(90);
  const writesBeforeProgress = harness.getRenderWrites().translation;

  for (let index = 1; index <= 10; index += 1) {
    harness.publishProgress(0, `译文片段 ${index}`);
  }

  assert.equal(
    harness.getRenderWrites().translation - writesBeforeProgress,
    0,
    "streamed fragments should stay outside the subtitle DOM"
  );

  harness.clock.tick(200);

  assert.equal(harness.getOverlayState().translation, "");
  assert.equal(
    harness.getRenderWrites().translation - writesBeforeProgress,
    0,
    "waiting between chunks must not expose a partial phrase"
  );

  harness.completeRequest(0, "完整译文");

  assert.equal(harness.getOverlayState().translation, "完整译文");
  assert.equal(
    harness.getRenderWrites().translation - writesBeforeProgress,
    1,
    "only the completed translation should be painted"
  );
});

test("late streaming progress cannot overwrite the final translation", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Final result wins.");
  harness.clock.tick(90);
  harness.publishProgress(0, "最终");
  harness.publishProgress(0, "最终结果即");
  harness.completeRequest(0, "最终结果优先");
  harness.publishProgress(0, "迟到的未完成译文");
  harness.clock.tick(200);

  assert.equal(harness.getOverlayState().translation, "最终结果优先");
  assert.equal(harness.getOverlayState().stale, false);
});

test("an unfinished segment is not superseded before its final result", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Hello.");
  harness.clock.tick(90);
  assert.equal(harness.requests.length, 1);

  harness.clock.tick(100);
  harness.setCaption("Hello world.");
  harness.clock.tick(420);
  assert.equal(
    harness.requests.length,
    1,
    "caption growth should wait for the first segment's final result"
  );
  assert.equal(harness.getOverlayState().source, "Hello.");

  harness.publishProgress(0, "你好");
  harness.clock.tick(420);
  assert.equal(
    harness.requests.length,
    1,
    "streaming progress must not replace an unfinished semantic segment"
  );
  assert.equal(harness.getOverlayState().source, "Hello.");

  harness.completeRequest(0, "你好");
  assert.equal(harness.getOverlayState().translation, "你好");
  harness.clock.tick(420);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].payload.text, "Hello world.");
});

test("an unrelated new caption does not show the previous sentence as its translation", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Hello.");
  harness.clock.tick(90);
  harness.publishProgress(0, "你好");
  harness.completeRequest(0, "你好");

  harness.clock.tick(100);
  harness.setCaption("How are you?");
  harness.clock.tick(90);

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.getOverlayState().source, "How are you?");
  assert.equal(harness.getOverlayState().translation, "");
  assert.equal(harness.getOverlayState().stale, false);
});

test("a growing caption keeps its related translation until the replacement is final", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("Hello world.");
  harness.clock.tick(90);
  harness.publishProgress(0, "你好，世界");
  harness.completeRequest(0, "你好，世界");

  harness.clock.tick(100);
  harness.setCaption("Hello world from London.");
  harness.clock.tick(90);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.getOverlayState().translation, "你好，世界");
  assert.equal(harness.getOverlayState().stale, true);

  harness.publishProgress(1, "你");

  assert.equal(
    harness.getOverlayState().translation,
    "你好，世界",
    "a one-token replacement must not collapse an already useful translation"
  );

  harness.publishProgress(1, "你好，来自伦敦");
  harness.clock.tick(200);

  assert.equal(
    harness.getOverlayState().translation,
    "你好，世界",
    "even a long streamed phrase must wait for the completed response"
  );
  assert.equal(harness.getOverlayState().stale, true);

  harness.completeRequest(1, "你好，世界，来自伦敦");

  assert.equal(harness.getOverlayState().translation, "你好，世界，来自伦敦");
  assert.equal(harness.getOverlayState().stale, false);
});

test("automatic-caption corrections retain the agreed stable prefix translation", async () => {
  const harness = await createContentHarness({ deferTranslations: true });

  harness.clock.tick(100);
  harness.setCaption("The Amazon is the law.");
  harness.clock.tick(90);
  harness.publishProgress(0, "亚马逊是法律");
  harness.completeRequest(0, "亚马逊是法律");

  harness.clock.tick(100);
  harness.setCaption("The Amazon is the largest rainforest.");
  harness.clock.tick(90);

  assert.equal(harness.getOverlayState().translation, "亚马逊是法律");
  assert.equal(
    harness.getOverlayState().stale,
    true,
    "the unchanged prefix should count as a related live-caption revision"
  );
});

test("short gaps in live caption nodes do not flash the overlay off", async () => {
  const harness = await createContentHarness();

  harness.clock.tick(100);
  harness.setCaption("A live caption.");
  harness.clock.tick(90);
  assert.equal(harness.getOverlayState().visible, true);

  harness.setCaption("");
  harness.clock.tick(90);
  harness.clock.tick(700);
  assert.equal(
    harness.getOverlayState().visible,
    true,
    "a transient caption gap should keep the last readable subtitle"
  );

  harness.clock.tick(250);
  assert.equal(harness.getOverlayState().visible, false);
});

test("a new live segment cancels a pending overlay clear", async () => {
  const harness = await createContentHarness();

  harness.clock.tick(100);
  harness.setCaption("First complete segment.");
  harness.clock.tick(90);
  harness.setCaption("");
  harness.clock.tick(700);

  harness.setCaption("Second complete segment.");
  harness.clock.tick(300);

  assert.equal(
    harness.getOverlayState().visible,
    true,
    "the previous gap timer must not clear a newly arrived segment"
  );
  assert.equal(harness.getOverlayState().source, "Second complete segment.");
});

test("full-track prefetch prioritizes the playback position and renders from cache", async () => {
  const cues = Array.from({ length: 14 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `subtitle ${index}`
  }));
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 12.2,
    captionTrack: {
      videoId: "video-1",
      cues
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.captionTrackRequests.length, 1);
  assert.match(
    harness.batchRequests[0].payload.cues[0].text,
    /subtitle 12/,
    "the first semantic segment should contain the playback position"
  );
  assert.equal(harness.requests.length, 0);
  const activeSegment = harness.batchRequests[0].payload.cues[0].text;
  assert.equal(
    harness.getOverlayState().translation,
    `batch:${activeSegment}`
  );
});

test("full-track prefetch translates and displays complete semantic segments", async () => {
  const firstSegment = "The road is difficult, but we keep moving.";
  const secondSegment = "A new idea starts here.";
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 1.2,
    captionTrack: {
      videoId: "video-segments",
      cues: [
        { id: "cue-1", startMs: 0, endMs: 1000, text: "The road" },
        { id: "cue-2", startMs: 1000, endMs: 2000, text: "is difficult," },
        {
          id: "cue-3",
          startMs: 2000,
          endMs: 3200,
          text: "but we keep moving."
        },
        { id: "cue-4", startMs: 3200, endMs: 4200, text: "A new idea" },
        { id: "cue-5", startMs: 4200, endMs: 5400, text: "starts here." }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.batchRequests[0].payload.cues[0].text,
    firstSegment,
    "fragmented timeline cues should be translated as one coherent segment"
  );
  assert.equal(harness.getOverlayState().source, firstSegment);
  assert.equal(harness.getOverlayState().translation, `batch:${firstSegment}`);

  harness.setCurrentTime(4.4);

  assert.equal(harness.getOverlayState().source, secondSegment);
  assert.equal(harness.getOverlayState().translation, `batch:${secondSegment}`);
});

test("caption batches include neighboring semantic segments across boundaries", async () => {
  const cues = Array.from({ length: 12 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `This is complete segment number ${index}.`
  }));
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 4.2,
    captionTrack: { videoId: "video-batch-context", cues }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.batchRequests[0].payload.context.before.join(" | "),
    "This is complete segment number 2. | This is complete segment number 3."
  );
  assert.equal(
    harness.batchRequests[0].payload.context.after.join(" | "),
    "This is complete segment number 5. | This is complete segment number 6."
  );
});

test("semantic segments remove rolling-caption overlap", async () => {
  const expectedSegment = "We are building something useful.";
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 1.2,
    captionTrack: {
      videoId: "video-overlap",
      cues: [
        { id: "cue-1", startMs: 0, endMs: 1000, text: "We are" },
        {
          id: "cue-2",
          startMs: 900,
          endMs: 1800,
          text: "We are building"
        },
        {
          id: "cue-3",
          startMs: 1700,
          endMs: 2800,
          text: "building something useful."
        }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.batchRequests[0].payload.cues[0].text, expectedSegment);
  assert.equal(harness.getOverlayState().source, expectedSegment);
  assert.equal(harness.getOverlayState().translation, `batch:${expectedSegment}`);
});

test("semantic segments split at a clear speaking pause", async () => {
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 0.2,
    captionTrack: {
      videoId: "video-pause",
      cues: [
        { id: "cue-1", startMs: 0, endMs: 1000, text: "First thought" },
        {
          id: "cue-2",
          startMs: 1900,
          endMs: 2900,
          text: "Second thought"
        }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.batchRequests
      .slice(0, 2)
      .map((request) => request.payload.cues.map((cue) => cue.text).join(" "))
      .join(" | "),
    "First thought | Second thought"
  );
  assert.deepEqual(
    harness.batchRequests
      .slice(0, 2)
      .map((request) => request.payload.cues.length),
    [1, 1]
  );
});

test("force retranslate keeps the complete active semantic segment", async () => {
  const expectedSegment = "The road is difficult, but we keep moving.";
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 1.2,
    captionTrack: {
      videoId: "video-force-segment",
      cues: [
        { id: "cue-1", startMs: 0, endMs: 1000, text: "The road" },
        { id: "cue-2", startMs: 1000, endMs: 2000, text: "is difficult," },
        {
          id: "cue-3",
          startMs: 2000,
          endMs: 3200,
          text: "but we keep moving."
        }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  harness.dispatchContentMessage({ type: "FORCE_RETRANSLATE" });
  harness.clock.tick(0);

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].payload.text, expectedSegment);
  assert.equal(harness.requests[0].payload.force, true);
});

test("unchanged prefetched captions do not rewrite the overlay on every timeupdate", async () => {
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 0.2,
    captionTrack: {
      videoId: "video-stable-render",
      cues: [
        {
          id: "cue-1",
          startMs: 0,
          endMs: 4000,
          text: "Keep this caption stable"
        }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  const initialWrites = harness.getRenderWrites();

  for (const time of [0.5, 1, 1.5, 2, 2.5]) {
    harness.setCurrentTime(time);
  }

  assert.deepEqual(
    harness.getRenderWrites(),
    initialWrites,
    "the same cue should not cause repeated text or style mutations"
  );
});

test("subtitle font size follows the player width without changing the saved preference", async () => {
  const harness = await createContentHarness({ playerWidth: 1280 });

  harness.clock.tick(100);
  harness.setCaption("Responsive subtitle.");
  harness.clock.tick(90);

  assert.equal(
    harness.getOverlayStyle("--yt-dst-render-font-size"),
    "30px"
  );

  harness.resizePlayer(560);

  assert.equal(
    harness.getOverlayStyle("--yt-dst-render-font-size"),
    "22.5px"
  );
});

test("the active and next segments start as independent urgent requests", async () => {
  const cues = Array.from({ length: 45 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `This is complete subtitle number ${index}.`
  }));
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 20.2,
    captionTrack: { videoId: "video-urgent", cues }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(harness.batchRequests[0].payload.cues[0].text, /number 20/);
  assert.match(harness.batchRequests[1].payload.cues[0].text, /number 21/);
  assert.deepEqual(
    harness.batchRequests.slice(0, 2).map((request) => request.payload.cues.length),
    [1, 1],
    "current and look-ahead subtitles should not wait on a large shared response"
  );
});

test("prefetch returns the active segment within one simulated API unit", async () => {
  const cues = Array.from({ length: 12 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `This is complete segment number ${index}.`
  }));
  const harness = await createContentHarness({
    batchResponseDelayPerCueMs: 250,
    prefetchEnabled: true,
    currentTime: 0.2,
    captionTrack: { videoId: "video-active-latency", cues }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.getOverlayState().translation,
    "batch:This is complete segment number 0.",
    "the active subtitle must not wait for future segments in the urgent batch"
  );
});

test("a completed look-ahead translation never renders before its cue starts", async () => {
  const currentText = "This is the current complete subtitle.";
  const nextText = "This is the next complete subtitle.";
  const harness = await createContentHarness({
    deferBatches: true,
    prefetchEnabled: true,
    currentTime: 0.85,
    captionTrack: {
      videoId: "video-no-early-lookahead",
      cues: [
        { id: "cue-current", startMs: 0, endMs: 1000, text: currentText },
        { id: "cue-next", startMs: 1000, endMs: 2000, text: nextText }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  harness.setCaption(nextText);
  harness.completeBatch(1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.getOverlayState().translation,
    "",
    "the translated look-ahead cue must stay hidden before its timeline start"
  );

  harness.setCurrentTime(1);
  assert.equal(harness.getOverlayState().translation, `batch:${nextText}`);
});

test("seeking reprioritizes the next queued caption batch", async () => {
  const cues = Array.from({ length: 300 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `subtitle ${index}`
  }));
  const harness = await createContentHarness({
    deferBatches: true,
    prefetchEnabled: true,
    currentTime: 0.2,
    captionTrack: { videoId: "video-seek", cues }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.batchRequests.length, 2);

  harness.setCurrentTime(240.2, "seeking");
  harness.completeBatch(0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.batchRequests.length, 3);
  assert.ok(
    harness.batchRequests[2].payload.cues.some(
      (cue) => cue.text.includes("subtitle 240")
    ),
    "the next free worker should translate the seek destination"
  );
});

test("caption mutations are observed at the player instead of the whole page", async () => {
  const harness = await createContentHarness();
  const observer = harness.getObserverState();

  assert.equal(observer.target, observer.player);
  assert.notEqual(observer.target, observer.documentElement);
});

test("force retranslate bypasses a prefetched caption and requests fresh output", async () => {
  const harness = await createContentHarness({
    prefetchEnabled: true,
    currentTime: 0.2,
    captionTrack: {
      videoId: "video-force",
      cues: [
        {
          id: "cue-1",
          startMs: 0,
          endMs: 1500,
          text: "Hello"
        }
      ]
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.requests.length, 0);

  harness.dispatchContentMessage({ type: "FORCE_RETRANSLATE" });
  harness.clock.tick(0);

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].payload.text, "Hello");
  assert.equal(harness.requests[0].payload.force, true);
  assert.equal(harness.getOverlayState().translation, "译文：Hello");

  harness.setCurrentTime(0.3);
  assert.equal(
    harness.getOverlayState().translation,
    "译文：Hello",
    "playback updates must not restore the stale prefetched translation"
  );
});

test("prefetch retries once more when captions appear after initial discovery failed", async () => {
  const recoveredTrack = {
    videoId: "video-after-ad",
    cues: [
      {
        id: "cue-1",
        startMs: 0,
        endMs: 1500,
        text: "After the ad"
      }
    ]
  };
  const harness = await createContentHarness({
    prefetchEnabled: true,
    captionTrackResponses: [null, null, null, null, null, recoveredTrack]
  });
  const advance = async (milliseconds) => {
    harness.clock.tick(milliseconds);
    await new Promise((resolve) => setImmediate(resolve));
  };

  await advance(350);
  await advance(800);
  await advance(1600);
  await advance(3000);
  await advance(5000);
  assert.equal(harness.captionTrackRequests.length, 5);

  harness.setCaption("After the ad");
  await advance(350);

  assert.equal(harness.captionTrackRequests.length, 6);
  assert.equal(harness.batchRequests.length, 1);
});

test("network failure stops background prefetch instead of multiplying requests", async () => {
  const cues = Array.from({ length: 50 }, (_value, index) => ({
    id: `cue-${index}`,
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    text: `subtitle ${index}`
  }));
  const harness = await createContentHarness({
    prefetchEnabled: true,
    captionTrack: { videoId: "network-failure", cues },
    batchError: {
      code: "NETWORK_ERROR",
      message: "offline"
    }
  });

  harness.clock.tick(350);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    harness.batchRequests.length <= 2,
    `network failure expanded into ${harness.batchRequests.length} requests`
  );
});
