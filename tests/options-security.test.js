"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const optionsSource = fs.readFileSync(
  path.resolve(__dirname, "..", "options.js"),
  "utf8"
);

test("options page never inserts connection errors through innerHTML", () => {
  assert.doesNotMatch(optionsSource, /connectionResult\.innerHTML\s*=/);
  assert.doesNotMatch(optionsSource, /keyState\.innerHTML\s*=/);
  assert.match(optionsSource, /container\.replaceChildren\(/);
});
