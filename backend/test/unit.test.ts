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
import { sanitizeImages } from "../src/utils/images.js";
import { buildSystemPrompt, FAST_MODE_INSTRUCTION } from "../src/system-prompt.js";
import { Value } from "typebox/value";
import {
  applyDefaultEntities,
  assumptionNotice,
  buildIntakeQuestion,
  confirmedParamsLine,
  gateDecision,
  IntakeExtractionSchema,
  missingEntities,
  normalizeExtraction,
  tomorrowAmsterdam,
  type IntakeExtraction,
} from "../src/intake.js";
import { veloGuideTools } from "../src/tools/index.js";
import { FeedbackSubmissionSchema, normalizeSubmission, openFeedbackStore } from "../src/feedback.js";
import { detectZigzags, straightLineFloor, ungroundedEndpoints, verifyRoute } from "../src/utils/geo-sanity.js";

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

test("intake gate: missing entities are detected and gate only new in-scope trips", () => {
  const full = { start_location: "Amsterdam", days: 1, start_date: "2026-06-20" };
  assert.deepEqual(missingEntities(full), []);
  assert.deepEqual(missingEntities({ start_location: null, days: null, start_date: null }), [
    "start location",
    "trip length",
    "start date",
  ]);

  const newTripMissing: IntakeExtraction = {
    intent: "new_trip", in_scope: true, start_location: "Amsterdam", days: null, start_date: null, date_conflict: false,
  };
  assert.equal(gateDecision(newTripMissing).gate, true, "new trip with missing length must be gated");
  assert.deepEqual(gateDecision(newTripMissing).missing, ["trip length"], "absent date alone is not asked");

  // Date policy: simply absent → no gate (tomorrow is assumed and disclosed);
  // conflicting → gate (the user must say which date counts).
  const dateOnlyMissing: IntakeExtraction = { ...newTripMissing, days: 1 };
  assert.equal(gateDecision(dateOnlyMissing).gate, false, "missing date alone defaults to tomorrow, no question");
  const conflict: IntakeExtraction = { ...dateOnlyMissing, date_conflict: true };
  assert.equal(gateDecision(conflict).gate, true, "conflicting dates must be clarified");
  assert.deepEqual(gateDecision(conflict).missing, ["start date"]);

  assert.equal(gateDecision({ ...newTripMissing, intent: "refinement" }).gate, false, "refinements bypass the gate");
  assert.equal(gateDecision({ ...newTripMissing, in_scope: false }).gate, false, "out-of-scope bypasses the gate");
  assert.equal(gateDecision({ ...newTripMissing, ...full, intent: "new_trip" }).gate, false, "complete params pass");
});

test("intake gate: question names exactly the missing pieces and the default fallback", () => {
  const q = buildIntakeQuestion(["trip length", "start date"], {
    start_location: "Amsterdam", days: null, start_date: null,
  });
  assert.ok(q.includes("Amsterdam"), "acknowledges the known start");
  assert.ok(/how many days/i.test(q), "asks for trip length");
  assert.ok(/which date counts/i.test(q), "asks which of the conflicting dates counts");
  assert.ok(!/where does the ride start/i.test(q), "does not re-ask the known start");
  assert.ok(/1-day trip from Amsterdam starting tomorrow/.test(q), "states the refusal fallback");
});

test("intake gate: refusal fills stated defaults and the params line discloses them", () => {
  const { entities, assumed } = applyDefaultEntities({ start_location: null, days: null, start_date: null });
  assert.equal(entities.start_location, "Amsterdam");
  assert.equal(entities.days, 1);
  assert.equal(entities.start_date, tomorrowAmsterdam());
  assert.match(entities.start_date!, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(assumed, ["start location", "trip length", "start date"]);

  const line = confirmedParamsLine(entities, assumed);
  assert.ok(/ASSUMED/.test(line), "params line flags assumptions");
  assert.ok(/do NOT restate/.test(line), "tells the agent the notice is pinned by the pipeline");
  assert.ok(!/ASSUMED/.test(confirmedParamsLine(entities)), "no assumption text when fully user-provided");

  // The pinned notice names exactly what was assumed, marking tomorrow.
  const notice = assumptionNotice(entities, assumed);
  assert.ok(notice.startsWith("*Assuming"), "notice leads the reply");
  assert.ok(notice.includes("a 1-day trip"), "names the assumed length");
  assert.ok(notice.includes("from Amsterdam"), "names the assumed start");
  assert.ok(notice.includes(`starting ${tomorrowAmsterdam()} (tomorrow)`), "names the assumed date as tomorrow");
  const dateOnly = assumptionNotice(
    { start_location: "Utrecht", days: 2, start_date: tomorrowAmsterdam() },
    ["start date"],
  );
  assert.ok(!dateOnly.includes("Utrecht") && !dateOnly.includes("2-day"), "only assumed fields are disclosed");

  // Partial refusal: provided values are kept, only gaps are filled.
  const partial = applyDefaultEntities({ start_location: "Utrecht", days: 2, start_date: null });
  assert.equal(partial.entities.start_location, "Utrecht");
  assert.equal(partial.entities.days, 2);
  assert.deepEqual(partial.assumed, ["start date"]);
});

test("intake gate: extraction JSON is normalized defensively", () => {
  const x = normalizeExtraction({ intent: "weird", days: "2", start_date: "June 20", start_location: "  Leiden " });
  assert.equal(x.intent, "new_trip", "unknown intent defaults to new_trip (the safe, gated path)");
  assert.equal(x.in_scope, true);
  assert.equal(x.days, 2, "numeric strings coerce");
  assert.equal(x.start_date, null, "non-ISO dates are rejected, not guessed");
  assert.equal(x.start_location, "Leiden");
  assert.equal(normalizeExtraction({ days: 0 }).days, null, "out-of-range days normalize to null (= ask)");
  assert.equal(normalizeExtraction({ days: 99 }).days, null);
  assert.equal(normalizeExtraction(null).start_location, null);
  assert.equal(normalizeExtraction({ date_conflict: true }).date_conflict, true);
  assert.equal(normalizeExtraction({}).date_conflict, false);
  assert.equal(
    normalizeExtraction({ date_conflict: true, start_date: "2026-06-20" }).date_conflict,
    false,
    "a resolved date cannot conflict",
  );
});

test("intake gate: every normalized extraction satisfies the TypeBox schema", () => {
  // The schema is the published contract (JSON Schema under the hood): the
  // inferred type and the runtime validator come from the same definition,
  // and Value.Check runs on every extraction. Sample hostile inputs.
  for (const raw of [
    null,
    {},
    { intent: "weird", days: "garbage", start_date: 42, start_location: 7 },
    { days: -3, start_date: "2026-99-99", in_scope: "yes" },
    { intent: "refinement", days: 3.7, start_date: "2026-06-20  ", date_conflict: "true" },
  ]) {
    const out = normalizeExtraction(raw);
    assert.ok(Value.Check(IntakeExtractionSchema, out), `schema violated for ${JSON.stringify(raw)}`);
  }
  // And the validator genuinely rejects out-of-contract objects.
  assert.equal(Value.Check(IntakeExtractionSchema, { intent: "new_trip" }), false, "missing fields fail");
  assert.equal(
    Value.Check(IntakeExtractionSchema, {
      intent: "new_trip", in_scope: true, start_location: null, days: 0, start_date: null, date_conflict: false,
    }),
    false,
    "days below minimum fails",
  );
});

test("sanitizeImages bounds untrusted client input", () => {
  assert.deepEqual(sanitizeImages(undefined), []);
  assert.deepEqual(sanitizeImages("nope"), []);
  const ok = { data: "aGVsbG8=", mimeType: "image/jpeg" };
  assert.deepEqual(sanitizeImages([ok]), [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" }]);
  assert.deepEqual(sanitizeImages([{ ...ok, mimeType: "application/pdf" }]), [], "non-image MIME dropped");
  assert.deepEqual(sanitizeImages([{ ...ok, data: "" }]), [], "empty data dropped");
  assert.deepEqual(sanitizeImages([{ ...ok, data: "x".repeat(8_000_001) }]), [], "oversized payload dropped");
  assert.equal(sanitizeImages(Array(10).fill(ok)).length, 4, "image count capped");
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
    "Confirmed trip parameters", // upstream intake-gate contract
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

// Real Dutch coordinates used across the geo-sanity tests.
const PLACES = {
  amsterdam: { lat: 52.3676, lon: 4.9041 },
  monnickendam: { lat: 52.459, lon: 5.0386 },
  marken: { lat: 52.4589, lon: 5.1039 },
  volendam: { lat: 52.4942, lon: 5.0747 },
  edam: { lat: 52.5132, lon: 5.0457 },
  purmerend: { lat: 52.505, lon: 4.9595 },
  enkhuizen: { lat: 52.7042, lon: 5.291 },
};

test("geo-sanity: straight-line floor flags geometrically impossible days", () => {
  // Amsterdam→Enkhuizen great-circle is ~45 km; you cannot cycle it in less.
  const wp = [PLACES.amsterdam, PLACES.enkhuizen];
  const { floorKm, ok } = straightLineFloor(wp);
  assert.ok(floorKm > 40 && floorKm < 50, `floor ~45 km, got ${floorKm.toFixed(1)}`);
  assert.equal(ok(30), false, "30 km < floor → impossible");
  assert.equal(ok(67.9), true, "67.9 km is above the floor → fine");
  // A loop (start ≈ end) has a ~0 floor, so it never false-fires.
  assert.equal(straightLineFloor([PLACES.amsterdam, PLACES.edam, PLACES.amsterdam]).ok(40), true);
});

test("geo-sanity: zigzag detection flags the Purmerend→Marken→Volendam backtrack", () => {
  // The real plan's weird ordering: Purmerend (inland NW) → Marken (SE islet) →
  // Volendam (back N) nearly doubles back — a sharp reversal.
  const zig = detectZigzags([PLACES.purmerend, PLACES.marken, PLACES.volendam, PLACES.edam]);
  assert.ok(zig.length >= 1, "the Marken detour must be flagged");
  assert.ok(zig.some((z) => z.angleDeg > 135), `expected a near-U-turn, got ${JSON.stringify(zig)}`);

  // A sensible monotonic route up the coast has no sharp reversals.
  const clean = detectZigzags([PLACES.amsterdam, PLACES.monnickendam, PLACES.volendam, PLACES.edam, PLACES.enkhuizen]);
  assert.deepEqual(clean, [], "a clean northbound route should not be flagged");

  // Sub-1km wiggles between close points are ignored (not planning errors).
  const wiggle = detectZigzags([PLACES.volendam, { lat: 52.4945, lon: 5.0749 }, PLACES.volendam], 135, 1);
  assert.deepEqual(wiggle, [], "tiny legs are below the minLegKm threshold");
});

test("geo-sanity: verifyRoute combines floor + zigzag into one verdict", () => {
  const v = verifyRoute([PLACES.purmerend, PLACES.marken, PLACES.volendam, PLACES.edam], 28);
  assert.equal(v.belowFloor, false, "28 km exceeds this short loop's floor");
  assert.ok(v.zigzags.length >= 1, "still flags the backtrack");
});

test("geo-sanity: endpoint grounding catches places no tool resolved", () => {
  const geocoded = ["Amsterdam, Noord-Holland, Nederland", "Enkhuizen, Noord-Holland, Nederland"];
  assert.deepEqual(ungroundedEndpoints(["Amsterdam", "Enkhuizen"], geocoded), [], "both endpoints are grounded");
  assert.deepEqual(
    ungroundedEndpoints(["Amsterdam", "Atlantis"], geocoded),
    ["Atlantis"],
    "an ungrounded endpoint is reported",
  );
  assert.deepEqual(ungroundedEndpoints([], geocoded), [], "no endpoints → nothing ungrounded");
});

test("feedback: submission is normalized defensively and schema-checked", () => {
  const ok = normalizeSubmission({ client_id: " c1 ", turn_id: "t1", rating: "down", comment: "  too long a day " });
  assert.equal(ok.client_id, "c1", "ids are trimmed");
  assert.equal(ok.rating, "down");
  assert.equal(ok.comment, "too long a day", "comment trimmed");
  assert.ok(Value.Check(FeedbackSubmissionSchema, ok));

  assert.equal(normalizeSubmission({ client_id: "c", turn_id: "t", rating: "up" }).comment, null, "absent comment → null");
  assert.equal(
    normalizeSubmission({ client_id: "c", turn_id: "t", rating: "up", comment: "   " }).comment,
    null,
    "blank comment → null",
  );

  // Invalid rating and missing ids must throw (the HTTP layer maps these to 400).
  assert.throws(() => normalizeSubmission({ client_id: "c", turn_id: "t", rating: "meh" }), /invalid feedback/);
  assert.throws(() => normalizeSubmission({ turn_id: "t", rating: "up" }), /invalid feedback/, "missing client_id");
  assert.throws(() => normalizeSubmission({ client_id: "c", rating: "up" }), /invalid feedback/, "missing turn_id");

  // Oversized comment is clamped, not rejected.
  const big = normalizeSubmission({ client_id: "c", turn_id: "t", rating: "down", comment: "x".repeat(5000) });
  assert.equal(big.comment!.length, 1000, "comment clamped to 1000 chars");
});

test("feedback: SQLite store records, counts, and reads back the joined trace", async () => {
  // In-memory DB — offline, no file, no network. Exercises the real node:sqlite
  // path (the production store), so record→stats→recent is covered end-to-end.
  const store = await openFeedbackStore(":memory:");
  assert.equal(store.enabled, true, "node:sqlite must be available on the test runtime (Node 22.5+)");

  const base = { turn_text: "Plan a day from Utrecht", plan_text: "Day 1: …", tool_calls: ["geocode", "plan_route"], model: "anthropic/claude-haiku-4.5" };
  store.record({ ...base, client_id: "c1", turn_id: "t1", rating: "up", comment: null, ts: "2026-06-11T10:00:00Z" });
  store.record({ ...base, client_id: "c2", turn_id: "t2", rating: "down", comment: "day 2 too long", ts: "2026-06-11T10:05:00Z" });

  assert.deepEqual(store.stats(), { up: 1, down: 1, total: 2 });

  const recent = store.recent(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].turn_id, "t2", "most recent first");
  assert.equal(recent[0].comment, "day 2 too long");
  assert.deepEqual(recent[0].tool_calls, ["geocode", "plan_route"], "tool trace round-trips through JSON");
  store.close();
});

test("feedback: disabled store is a no-op (FEEDBACK_DB unset)", async () => {
  const store = await openFeedbackStore(undefined);
  assert.equal(store.enabled, false);
  store.record({
    client_id: "c", turn_id: "t", rating: "up", comment: null,
    turn_text: "x", plan_text: "y", tool_calls: [], model: "m", ts: "2026-06-11T10:00:00Z",
  });
  assert.deepEqual(store.stats(), { up: 0, down: 0, total: 0 }, "no-op store stores nothing");
  assert.deepEqual(store.recent(10), []);
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
    if (tc.turns !== undefined) {
      assert.ok(
        Array.isArray(tc.turns) && tc.turns.every((t: unknown) => typeof t === "string" && t),
        `${tc.id}: turns must be non-empty strings`,
      );
    }
    if (tc.expect_clarification !== undefined) {
      assert.equal(typeof tc.expect_clarification, "boolean", `${tc.id}: expect_clarification must be boolean`);
    }
    if (tc.expect_clarification) {
      assert.ok(
        Array.isArray(tc.turns) && tc.turns.length > 0,
        `${tc.id}: a gated case needs follow-up turns to reach a plan`,
      );
    }
  }
});
