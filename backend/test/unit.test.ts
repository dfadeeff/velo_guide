// Offline unit tests — no network, no API key. These run in CI on every push
// (the live agent eval needs OPENROUTER_API_KEY and is dispatched manually).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { formatDuration, formatDistance, haversineDistance, cardinalBearing } from "../src/utils/format.js";
import { buildBbox } from "../src/utils/overpass.js";
import { textResult, jsonResult } from "../src/utils/tool-result.js";
import { buildSystemPrompt, FAST_MODE_INSTRUCTION } from "../src/system-prompt.js";
import { veloGuideTools } from "../src/tools/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("formatDuration renders hours and minutes", () => {
  assert.equal(formatDuration(45 * 60_000), "45 min");
  assert.equal(formatDuration(90 * 60_000), "1h 30min");
  assert.equal(formatDuration(0), "0 min");
});

test("formatDistance renders km with one decimal", () => {
  assert.equal(formatDistance(15_500), "15.5 km");
  assert.equal(formatDistance(900), "0.9 km");
});

test("haversineDistance: Amsterdam–Utrecht is ~35 km", () => {
  const d = haversineDistance(52.3676, 4.9041, 52.0907, 5.1214);
  assert.ok(d > 30_000 && d < 40_000, `expected ~35 km, got ${(d / 1000).toFixed(1)} km`);
});

test("cardinalBearing matches known Dutch geography", () => {
  // Kinderdijk is east-southeast of Rotterdam — the direction the model once
  // hallucinated as "northeast"; this pins the fix.
  const rotterdamToKinderdijk = cardinalBearing(51.9225, 4.47917, 51.8841, 4.6322);
  assert.ok(["east", "southeast"].includes(rotterdamToKinderdijk), `got ${rotterdamToKinderdijk}`);

  const amsterdamToMarken = cardinalBearing(52.3676, 4.9041, 52.4589, 5.1039);
  assert.equal(amsterdamToMarken, "northeast");

  assert.equal(cardinalBearing(52.0, 5.0, 53.0, 5.0), "north");
  assert.equal(cardinalBearing(52.0, 5.0, 51.0, 5.0), "south");
});

test("buildBbox produces a south,west,north,east box around the center", () => {
  const parts = buildBbox(52.0, 5.0, 2000).split(",").map(Number);
  assert.equal(parts.length, 4);
  const [south, west, north, east] = parts;
  assert.ok(south < 52.0 && north > 52.0 && west < 5.0 && east > 5.0);
  // 2 km radius ≈ 0.018° latitude
  assert.ok(Math.abs(north - south - 0.036) < 0.002);
});

test("tool result helpers encapsulate the envelope", () => {
  const t = textResult("hello");
  assert.deepEqual(t.content, [{ type: "text", text: "hello" }]);
  const j = jsonResult({ a: 1 });
  assert.equal(j.content[0].type, "text");
  assert.deepEqual(JSON.parse((j.content[0] as { type: "text"; text: string }).text), { a: 1 });
});

test("system prompt carries today's date and the grounding rules", () => {
  const prompt = buildSystemPrompt();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });
  assert.ok(prompt.includes(`Today is ${today}`), "current date must be injected");
  for (const marker of [
    "NEVER estimate distances",
    "NEVER invent places",
    "knooppunten",
    "NEVER state a compass direction",
    "Hard rule on day balance",
  ]) {
    assert.ok(prompt.includes(marker), `prompt must contain "${marker}"`);
  }
  assert.ok(FAST_MODE_INSTRUCTION.includes("FAST MODE"));
});

test("exactly 7 tools, complete and uniquely named", () => {
  assert.equal(veloGuideTools.length, 7);
  const names = veloGuideTools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const tool of veloGuideTools) {
    assert.ok(tool.name && tool.label && tool.description, `${tool.name}: metadata incomplete`);
    assert.ok(tool.parameters, `${tool.name}: missing parameter schema`);
    assert.equal(typeof tool.execute, "function", `${tool.name}: missing execute`);
  }
});

test("eval test cases are well-formed and fixtures exist", () => {
  const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../eval/test-cases.json"), "utf-8"));
  assert.ok(Array.isArray(cases) && cases.length >= 7);
  const toolNames = new Set(veloGuideTools.map((t) => t.name));
  for (const tc of cases) {
    assert.ok(tc.id && tc.name && tc.input, `${tc.id}: missing required fields`);
    assert.ok(Array.isArray(tc.expected_tools) && Array.isArray(tc.assertions), `${tc.id}: bad arrays`);
    for (const t of tc.expected_tools) {
      assert.ok(toolNames.has(t), `${tc.id}: expected tool "${t}" does not exist`);
    }
    if (tc.image) {
      assert.ok(fs.existsSync(path.resolve(__dirname, "../eval", tc.image)), `${tc.id}: fixture ${tc.image} missing`);
    }
    if (tc.reply_must_match) new RegExp(tc.reply_must_match, "i"); // must compile
  }
});
