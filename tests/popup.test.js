"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

class FakeClassList {
  add() {}
  toggle() {}
}

function createElement() {
  return {
    checked: false,
    classList: new FakeClassList(),
    className: "",
    disabled: false,
    hidden: false,
    textContent: "",
    addEventListener() {}
  };
}

test("popup allows retranslation when a prefetched subtitle is visible without CC", async () => {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, createElement());
      }
      return elements.get(id);
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      openOptionsPage() {},
      sendMessage(message, callback) {
        if (message.type === "GET_EXTENSION_SETTINGS") {
          callback({
            ok: true,
            hasApiKey: true,
            settings: {
              enabled: true,
              prefetchEnabled: true,
              targetLanguage: "zh-CN",
              model: "deepseek-v4-flash",
              displayMode: "bilingual"
            }
          });
        }
      }
    },
    tabs: {
      async query() {
        return [
          {
            id: 8,
            url: "https://www.youtube.com/watch?v=prefetched"
          }
        ];
      },
      sendMessage(_tabId, message, callback) {
        if (message.type === "GET_TRANSLATOR_STATUS") {
          callback({
            ok: true,
            status: {
              enabled: true,
              playerFound: true,
              captionFound: false,
              hasTranslation: true,
              prefetchStatus: "ready",
              prefetchTranslated: 20,
              prefetchTotal: 20
            }
          });
        }
      }
    }
  };
  const context = vm.createContext({ chrome, console, document });
  context.globalThis = context;
  context.self = context;

  for (const file of ["shared.js", "popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
      filename: file
    });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get("retranslate").disabled, false);
});
