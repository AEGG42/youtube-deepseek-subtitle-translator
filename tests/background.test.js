"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function createBackgroundHarness(overrides = {}) {
  const listeners = {};
  const store = {
    enabled: true,
    apiKey: "test-private-key",
    wordLookupEnabled: true,
    wordLookupAiFallback: true,
    targetLanguage: "zh-CN",
    model: "deepseek-v4-flash",
    displayMode: "bilingual",
    fontSize: 30,
    backgroundOpacity: 0.62,
    subtitleBottom: 12,
    translationDelay: 420,
    ...overrides.store
  };
  const fetchCalls = [];
  const tabMessages = [];
  const sessionStore = overrides.sessionStore || {};
  let storageAccessLevel = null;

  const event = (name) => ({
    addListener(listener) {
      listeners[name] = listener;
    }
  });

  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      getURL(relativePath = "") {
        return `chrome-extension://test-extension/${relativePath}`;
      },
      onInstalled: event("onInstalled"),
      onStartup: event("onStartup"),
      onMessage: event("onMessage"),
      async openOptionsPage() {}
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return { ...store };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(store, key))
                .map((key) => [key, store[key]])
            );
          }
          return {};
        },
        async set(values) {
          Object.assign(store, values);
        },
        async setAccessLevel({ accessLevel }) {
          storageAccessLevel = accessLevel;
        }
      },
      session: {
        async get(keys) {
          if (keys === null || keys === undefined) {
            return { ...sessionStore };
          }
          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys
                .filter((key) => Object.hasOwn(sessionStore, key))
                .map((key) => [key, sessionStore[key]])
            );
          }
          if (typeof keys === "string") {
            return Object.hasOwn(sessionStore, keys)
              ? { [keys]: sessionStore[keys] }
              : {};
          }
          return {};
        },
        async set(values) {
          if (overrides.sessionSet) {
            return overrides.sessionSet(values, sessionStore);
          }
          Object.assign(sessionStore, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete sessionStore[key];
          }
        }
      },
      onChanged: event("storage.onChanged")
    },
    tabs: {
      async query() {
        return [];
      },
      sendMessage(tabId, message, callback) {
        tabMessages.push({ tabId, message });
        callback?.();
      }
    },
    action: {
      async setBadgeBackgroundColor() {},
      async setBadgeText() {},
      async setTitle() {}
    },
    scripting: {
      async executeScript(options) {
        if (overrides.executeScript) {
          return overrides.executeScript(options);
        }
        return [{ result: null }];
      }
    }
  };

  const context = vm.createContext({
    AbortController,
    TextDecoder,
    URL,
    clearTimeout,
    console,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      if (overrides.fetch) {
        return overrides.fetch(url, options);
      }
      if (String(url).startsWith("chrome-extension://test-extension/")) {
        const relativePath = String(url).replace(
          "chrome-extension://test-extension/",
          ""
        );
        const filePath = path.join(root, relativePath);
        if (!fs.existsSync(filePath)) {
          return {
            ok: false,
            status: 404,
            async json() {
              return {};
            }
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return JSON.parse(fs.readFileSync(filePath, "utf8"));
          }
        };
      }
      const requestBody = JSON.parse(options.body);
      if (requestBody.stream) {
        const encoder = new TextEncoder();
        const events = [
          `data: ${JSON.stringify({
            model: "deepseek-v4-flash",
            choices: [{ delta: { content: "你" } }]
          })}\n\n`,
          `data: ${JSON.stringify({
            model: "deepseek-v4-flash",
            choices: [{ delta: { content: "好" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12
            }
          })}\n\n`,
          "data: [DONE]\n\n"
        ].map((event) => encoder.encode(event));
        let eventIndex = 0;

        return {
          ok: true,
          status: 200,
          body: {
            getReader() {
              return {
                async read() {
                  if (eventIndex >= events.length) {
                    return { done: true, value: undefined };
                  }
                  return { done: false, value: events[eventIndex++] };
                }
              };
            }
          },
          async text() {
            return "";
          }
        };
      }
      if (requestBody.response_format?.type === "json_object") {
        const input = JSON.parse(requestBody.messages[1].content);
        if (input.word) {
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                model: "deepseek-v4-flash",
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        lemma: input.word,
                        phonetic: "",
                        partOfSpeech: "n.",
                        meaning: `AI释义：${input.word}`
                      })
                    }
                  }
                ],
                usage: {
                  prompt_tokens: 90,
                  completion_tokens: 18,
                  total_tokens: 108
                }
              });
            }
          };
        }
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              model: "deepseek-v4-flash",
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      translations: input.subtitles.map(({ id, text }) => ({
                        id,
                        text: `translated:${text}`
                      }))
                    })
                  }
                }
              ]
            });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            model: "deepseek-v4-flash",
            choices: [{ message: { content: "你好" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              total_tokens: 12
            }
          });
        }
      };
    },
    setTimeout,
    chrome
  });

  context.globalThis = context;
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      vm.runInContext(source, context, { filename: file });
    }
  };

  const backgroundSource = fs.readFileSync(
    path.join(root, "background.js"),
    "utf8"
  );
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  async function dispatch(message, sender = {}) {
    return new Promise((resolve, reject) => {
      const handled = listeners.onMessage(message, sender, resolve);
      if (!handled) {
        reject(new Error(`Message was not handled: ${message.type}`));
      }
    });
  }

  return {
    dispatch,
    fetchCalls,
    tabMessages,
    getStorageAccessLevel: () => storageAccessLevel,
    sessionStore,
    store
  };
}

test("background restricts local storage to trusted contexts", async () => {
  const harness = createBackgroundHarness();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.getStorageAccessLevel(), "TRUSTED_CONTEXTS");
});

test("settings summary never sends the API key to callers", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    { type: "GET_EXTENSION_SETTINGS" },
    {
      id: "test-extension",
      url: "chrome-extension://test-extension/options.html"
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.hasApiKey, true);
  assert.equal(Object.hasOwn(response.settings, "apiKey"), false);
  assert.match(response.maskedApiKey, /^test.+-key$/);
});

test("YouTube content receives public settings without any key metadata", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    { type: "GET_PUBLIC_SETTINGS" },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=test",
      tab: { url: "https://www.youtube.com/watch?v=test" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(Object.hasOwn(response.settings, "apiKey"), false);
  assert.equal(Object.hasOwn(response, "maskedApiKey"), false);
  assert.equal(Object.hasOwn(response, "hasApiKey"), false);
});

test("YouTube translation uses the stored key only in the API authorization header", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    {
      type: "TRANSLATE_SUBTITLE",
      payload: { text: "Hello", context: ["Welcome"], requestId: 7 }
    },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=test",
      tab: { id: 44, url: "https://www.youtube.com/watch?v=test" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.translation, "你好");
  assert.equal(harness.fetchCalls.length, 1);

  const call = harness.fetchCalls[0];
  const body = JSON.parse(call.options.body);
  const userInput = JSON.parse(body.messages[1].content);

  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(
    call.options.headers.Authorization,
    "Bearer test-private-key"
  );
  assert.equal(body.stream, true);
  assert.equal(userInput.subtitle, "Hello");
  assert.deepEqual(
    Array.from(userInput.context),
    ["Welcome"]
  );
  assert.deepEqual({ ...body.thinking }, { type: "disabled" });
  assert.deepEqual(
    harness.tabMessages
      .filter(({ message }) => message.type === "TRANSLATION_PROGRESS")
      .map(({ message }) => message.translation),
    ["你", "你好"]
  );
});

test("background rejects subtitle messages from non-YouTube senders", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    {
      type: "TRANSLATE_SUBTITLE",
      payload: { text: "Hello" }
    },
    { tab: { url: "https://example.com/" } }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNTRUSTED_SENDER");
  assert.equal(harness.fetchCalls.length, 0);
});

test("word lookup uses the packaged dictionary without calling DeepSeek", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    {
      type: "LOOKUP_WORD",
      payload: {
        word: "approach",
        sentence: "We need a different approach."
      }
    },
    {
      id: "test-extension",
      tab: { id: 7, url: "https://www.youtube.com/watch?v=abc" }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.source, "dictionary");
  assert.match(response.meaning, /接近/);
  assert.equal(
    harness.fetchCalls.filter(
      ({ url }) => url === "https://api.deepseek.com/chat/completions"
    ).length,
    0
  );
});

test("word lookup falls back to DeepSeek for a local dictionary miss and caches it", async () => {
  const harness = createBackgroundHarness();
  const request = {
    type: "LOOKUP_WORD",
    payload: {
      word: "youtube",
      sentence: "This tutorial is on YouTube.",
      translation: "这个教程在 YouTube 上。"
    }
  };
  const sender = {
    id: "test-extension",
    tab: { id: 8, url: "https://www.youtube.com/watch?v=abc" }
  };

  const first = await harness.dispatch(request, sender);
  const second = await harness.dispatch(request, sender);
  const apiCalls = harness.fetchCalls.filter(
    ({ url }) => url === "https://api.deepseek.com/chat/completions"
  );

  assert.equal(first.ok, true);
  assert.equal(first.source, "ai");
  assert.equal(first.meaning, "AI释义：youtube");
  assert.equal(first.usage.totalTokens, 108);
  assert.equal(second.cached, true);
  assert.equal(apiCalls.length, 1);
  assert.equal(
    JSON.parse(apiCalls[0].options.body).messages[1].content.includes(
      "This tutorial is on YouTube."
    ),
    true
  );
  assert.equal(
    apiCalls[0].options.headers.Authorization,
    "Bearer test-private-key"
  );
});

test("word lookup does not use AI when fallback is disabled", async () => {
  const harness = createBackgroundHarness({
    store: { wordLookupAiFallback: false }
  });
  const response = await harness.dispatch(
    {
      type: "LOOKUP_WORD",
      payload: { word: "youtube", sentence: "YouTube" }
    },
    {
      id: "test-extension",
      tab: { id: 9, url: "https://www.youtube.com/watch?v=abc" }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "WORD_NOT_FOUND");
  assert.equal(
    harness.fetchCalls.filter(
      ({ url }) => url === "https://api.deepseek.com/chat/completions"
    ).length,
    0
  );
});

test("content scripts cannot mutate privileged settings", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    {
      type: "SAVE_EXTENSION_SETTINGS",
      payload: { apiKey: "replacement-key" }
    },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=test",
      tab: { url: "https://www.youtube.com/watch?v=test" }
    }
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNTRUSTED_SENDER");
  assert.equal(harness.store.apiKey, "test-private-key");
});

test("the trusted popup can toggle the extension", async () => {
  const harness = createBackgroundHarness();
  const response = await harness.dispatch(
    {
      type: "SET_EXTENSION_ENABLED",
      enabled: false
    },
    {
      id: "test-extension",
      url: "chrome-extension://test-extension/popup.html"
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.enabled, false);
  assert.equal(harness.store.enabled, false);
});

test("cancelling a stale subtitle aborts its in-flight API request", async () => {
  const harness = createBackgroundHarness({
    fetch(_url, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    }
  });
  const sender = {
    id: "test-extension",
    url: "https://www.youtube.com/watch?v=test",
    tab: { id: 91, url: "https://www.youtube.com/watch?v=test" }
  };

  const translationPromise = harness.dispatch(
    {
      type: "TRANSLATE_SUBTITLE",
      payload: { text: "Old subtitle", requestId: 11 }
    },
    sender
  );
  await new Promise((resolve) => setImmediate(resolve));

  const cancelResponse = await harness.dispatch(
    { type: "CANCEL_TRANSLATION", requestId: 11 },
    sender
  );
  const translationResponse = await translationPromise;

  assert.equal(cancelResponse.ok, true);
  assert.equal(translationResponse.ok, false);
  assert.equal(translationResponse.error.code, "REQUEST_CANCELLED");
});

test("background discovers and downloads the current timed caption track", async () => {
  let injectedOptions = null;
  const harness = createBackgroundHarness({
    executeScript(options) {
      injectedOptions = options;
      return [
        {
          result: {
            videoId: "video-123",
            activeResourceUrl: "",
            activeLanguageCode: "en",
            activeVssId: ".en",
            tracks: [
              {
                baseUrl:
                  "https://www.youtube.com/api/timedtext?v=video-123&lang=en",
                languageCode: "en",
                vssId: ".en",
                kind: "",
                name: "English"
              }
            ]
          }
        }
      ];
    },
    fetch(url, options) {
      assert.equal(options.method, "GET");
      const parsedUrl = new URL(url);
      assert.equal(parsedUrl.hostname, "www.youtube.com");
      assert.equal(parsedUrl.pathname, "/api/timedtext");
      assert.equal(parsedUrl.searchParams.get("fmt"), "json3");
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            events: [
              {
                tStartMs: 0,
                dDurationMs: 1200,
                segs: [{ utf8: "Hello " }, { utf8: "world" }]
              },
              {
                tStartMs: 1200,
                dDurationMs: 1000,
                segs: [{ utf8: "Next line" }]
              }
            ]
          });
        }
      };
    }
  });
  const response = await harness.dispatch(
    { type: "LOAD_YOUTUBE_CAPTIONS" },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=video-123",
      tab: {
        id: 61,
        url: "https://www.youtube.com/watch?v=video-123"
      }
    }
  );

  assert.equal(response.ok, true);
  assert.equal(response.videoId, "video-123");
  assert.equal(response.languageCode, "en");
  assert.equal(response.cues.length, 2);
  assert.deepEqual(
    {
      startMs: response.cues[0].startMs,
      endMs: response.cues[0].endMs,
      text: response.cues[0].text
    },
    { startMs: 0, endMs: 1200, text: "Hello world" }
  );
  assert.equal(injectedOptions.world, "MAIN");
});

test("background translates a caption batch without exposing the stored key", async () => {
  const harness = createBackgroundHarness({
    fetch(url, options) {
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages[1].content);

      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test-private-key");
      assert.equal(body.stream, false);
      assert.deepEqual(
        Array.from(input.subtitles, ({ id, text }) => ({ id, text })),
        [
          { id: "cue-1", text: "Hello" },
          { id: "cue-2", text: "World" }
        ]
      );

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            model: "deepseek-v4-flash",
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    translations: [
                      { id: "cue-1", text: "你好" },
                      { id: "cue-2", text: "世界" }
                    ]
                  })
                }
              }
            ]
          });
        }
      };
    }
  });
  const response = await harness.dispatch(
    {
      type: "TRANSLATE_CAPTION_BATCH",
      payload: {
        videoId: "video-123",
        cues: [
          { id: "cue-1", text: "Hello" },
          { id: "cue-2", text: "World" }
        ]
      }
    },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=video-123",
      tab: {
        id: 62,
        url: "https://www.youtube.com/watch?v=video-123"
      }
    }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(
    Array.from(response.translations, ({ id, text }) => ({ id, text })),
    [
      { id: "cue-1", text: "你好" },
      { id: "cue-2", text: "世界" }
    ]
  );
  assert.equal(Object.hasOwn(response, "apiKey"), false);
});

test("identical caption batches reuse the bounded background cache", async () => {
  const harness = createBackgroundHarness();
  const sender = {
    id: "test-extension",
    url: "https://www.youtube.com/watch?v=cached-video",
    tab: {
      id: 63,
      url: "https://www.youtube.com/watch?v=cached-video"
    }
  };
  const message = {
    type: "TRANSLATE_CAPTION_BATCH",
    payload: {
      videoId: "cached-video",
      cues: [{ id: "cue-1", text: "Hello" }]
    }
  };

  const first = await harness.dispatch(message, sender);
  const second = await harness.dispatch(message, sender);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(harness.fetchCalls.length, 1);
});

test("overlapping caption batches send only cache misses to DeepSeek", async () => {
  const harness = createBackgroundHarness();
  const sender = {
    id: "test-extension",
    url: "https://www.youtube.com/watch?v=overlap-video",
    tab: {
      id: 64,
      url: "https://www.youtube.com/watch?v=overlap-video"
    }
  };

  await harness.dispatch(
    {
      type: "TRANSLATE_CAPTION_BATCH",
      payload: {
        videoId: "overlap-video",
        cues: [
          { id: "cue-1", text: "One" },
          { id: "cue-2", text: "Two" }
        ]
      }
    },
    sender
  );
  const response = await harness.dispatch(
    {
      type: "TRANSLATE_CAPTION_BATCH",
      payload: {
        videoId: "overlap-video",
        cues: [
          { id: "cue-2", text: "Two" },
          { id: "cue-3", text: "Three" }
        ],
        context: {
          before: ["Before the overlap."],
          after: ["After the overlap."]
        }
      }
    },
    sender
  );

  const secondRequest = JSON.parse(harness.fetchCalls[1].options.body);
  const secondInput = JSON.parse(secondRequest.messages[1].content);
  assert.deepEqual(
    Array.from(secondInput.subtitles, ({ id }) => id),
    ["cue-2", "cue-3"]
  );
  assert.deepEqual(Array.from(secondInput.targetIds), ["cue-3"]);
  assert.equal(
    secondInput.subtitles[0].translation,
    "translated:Two",
    "a cached neighboring translation should anchor terminology without being retranslated"
  );
  assert.deepEqual(Array.from(secondInput.contextBefore), [
    "Before the overlap."
  ]);
  assert.deepEqual(Array.from(secondInput.contextAfter), [
    "After the overlap."
  ]);
  assert.equal(response.cacheHits, 1);
  assert.deepEqual(
    Array.from(response.translations, ({ id }) => id),
    ["cue-2", "cue-3"]
  );
});

test("session cache survives an extension service-worker restart", async () => {
  const sessionStore = {};
  const sender = {
    id: "test-extension",
    url: "https://www.youtube.com/watch?v=session-video",
    tab: {
      id: 65,
      url: "https://www.youtube.com/watch?v=session-video"
    }
  };
  const message = {
    type: "TRANSLATE_CAPTION_BATCH",
    payload: {
      videoId: "session-video",
      cues: [{ id: "cue-1", text: "Persist me" }]
    }
  };

  const firstWorker = createBackgroundHarness({ sessionStore });
  const first = await firstWorker.dispatch(message, sender);
  await new Promise((resolve) => setImmediate(resolve));
  const restartedWorker = createBackgroundHarness({ sessionStore });
  const second = await restartedWorker.dispatch(message, sender);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(restartedWorker.fetchCalls.length, 0);
});

test("forced subtitle translation bypasses the realtime response cache", async () => {
  const harness = createBackgroundHarness();
  const sender = {
    id: "test-extension",
    url: "https://www.youtube.com/watch?v=force-video",
    tab: {
      id: 66,
      url: "https://www.youtube.com/watch?v=force-video"
    }
  };

  await harness.dispatch(
    {
      type: "TRANSLATE_SUBTITLE",
      payload: { text: "Hello", context: [], requestId: 1 }
    },
    sender
  );
  const forced = await harness.dispatch(
    {
      type: "TRANSLATE_SUBTITLE",
      payload: {
        text: "Hello",
        context: [],
        requestId: 2,
        force: true
      }
    },
    sender
  );

  assert.equal(forced.ok, true);
  assert.equal(forced.cached, false);
  assert.equal(harness.fetchCalls.length, 2);
});

test("batch response waits until its session-cache write is durable", async () => {
  let finishSessionWrite;
  let sessionWriteStarted = false;
  const harness = createBackgroundHarness({
    sessionSet(values, sessionStore) {
      sessionWriteStarted = true;
      return new Promise((resolve) => {
        finishSessionWrite = () => {
          Object.assign(sessionStore, values);
          resolve();
        };
      });
    }
  });
  const responsePromise = harness.dispatch(
    {
      type: "TRANSLATE_CAPTION_BATCH",
      payload: {
        videoId: "durable-video",
        cues: [{ id: "cue-1", text: "Hello" }]
      }
    },
    {
      id: "test-extension",
      url: "https://www.youtube.com/watch?v=durable-video",
      tab: {
        id: 67,
        url: "https://www.youtube.com/watch?v=durable-video"
      }
    }
  );
  let responseResolved = false;
  void responsePromise.then(() => {
    responseResolved = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessionWriteStarted, true);
  assert.equal(responseResolved, false);

  finishSessionWrite();
  const response = await responsePromise;
  assert.equal(response.ok, true);
});
