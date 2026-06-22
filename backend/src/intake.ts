// Deterministic intake gate — runs BEFORE the planning agent on every user turn.
//
// Policy: a new trip is only planned once these are settled:
//   1. start location (from text, or identified from an attached photo) — asked if missing
//   2. trip length in days (1-3) — asked if missing
//   3. start date (needed for a real weather forecast) — NOT asked if simply
//      absent: tomorrow is assumed and the plan must state that on top. Asked
//      only when the user gave CONFLICTING dates ("today" + "from June 20").
//
// Enforcement is structural, not prompt-based: extraction is a plain chat
// completion with NO TOOLS ATTACHED, so this step cannot route, geocode, or
// plan anything. When a parameter is missing or ambiguous (e.g. conflicting
// dates), the pipeline answers with one targeted question and the planning
// agent is never invoked — see pipeline.ts. Refinements of an already
// delivered plan bypass the gate.
//
// The gate asks AT MOST ONCE per trip request: if the user's next turn still
// leaves parameters open (refused, ignored, "just plan something"), the
// pipeline falls back to stated defaults — 1 day, from Amsterdam, starting
// tomorrow — and the plan must open by stating those assumptions.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { currentDateLine } from "./system-prompt.js";
import { DEFAULT_MODEL } from "./agent.js";
import type { ImageInput } from "./utils/images.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// The typed contract for what the system must know before planning. LLM
// extraction output is parsed THROUGH this schema (normalizeExtraction below),
// so anything malformed — junk day counts, non-ISO dates, unknown intents —
// is normalized at the boundary instead of leaking into the pipeline. Same
// role Pydantic models play in a Python service, using the schema library the
// tools already declare their parameters with.
export const IntakeExtractionSchema = Type.Object({
  intent: Type.Union([Type.Literal("new_trip"), Type.Literal("refinement"), Type.Literal("other")]),
  in_scope: Type.Boolean(),
  start_location: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  days: Type.Union([Type.Integer({ minimum: 1, maximum: 14 }), Type.Null()]),
  start_date: Type.Union([Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), Type.Null()]),
  // The user gave two dates that disagree — must be clarified, never resolved
  // silently to either one (a plain missing date is NOT a conflict).
  date_conflict: Type.Boolean(),
});

export type IntakeExtraction = Static<typeof IntakeExtractionSchema>;
export type TripEntities = Pick<IntakeExtraction, "start_location" | "days" | "start_date">;

export interface UserTurn {
  text: string;
  images?: ImageInput[];
}

const EXTRACTION_SYSTEM = `You are the intake step of a cycling trip planner for the Netherlands. ${"" /* date anchor appended at call time */}
Read the user's conversation turns (oldest first) and extract the trip parameters. Respond with ONLY a JSON object, no markdown fences:
{"intent":"new_trip"|"refinement"|"other","in_scope":true|false,"start_location":string|null,"days":number|null,"start_date":"YYYY-MM-DD"|null,"date_conflict":true|false}

Rules:
- intent: "new_trip" when the user asks to plan a trip or names a new start city/region (including "a trip from this city" with a photo attached); "refinement" when adjusting a trip already being discussed ("make day 2 shorter", "more nature"); "other" for greetings or unrelated questions.
- in_scope: false if the requested riding area is clearly outside the Netherlands — INCLUDING a place shown in an attached photo. If a photo looks like a non-Dutch location (a foreign city, mountains, a tropical coast, etc.), set in_scope false.
- start_location: the city/town/region the ride STARTS from. If the only clue is an attached photo, make your BEST-EFFORT identification of the most likely Dutch city/town shown — you do NOT need a famous landmark. Use every cue: canal and harbour layout, brick gable architecture, church towers, bridges, street/shop signage, boats, the general character of the place. Most Dutch town and canal scenes ARE attributable to a specific city by someone who knows the country, so name your single best guess (e.g. a harbour of old boats ringed by gabled houses in the north → "Groningen"). The guess is ALWAYS shown back to the user for confirmation before the trip is committed ("It looks like X — correct me if that's wrong"), so a medium- or low-confidence guess is useful, not dangerous — refusing to name a clearly-Dutch town is the worse outcome. Return start_location null ONLY when the photo carries no place signal at all (a close-up of a bicycle, a plain field, a generic interior). If the photo is clearly OUTSIDE the Netherlands → in_scope false, start_location null — never coerce a foreign place into a Dutch city. When the user names a city in TEXT, use that and do not override it from the photo.
- days: trip length in days, ONLY when a length is explicitly stated: "one-day"/"day trip" = 1, "weekend" = 2, "3-day" = 3. A bare "cycling trip" states NO length — days is null. Never infer 1 from the absence of a length.
- start_date: resolve relative dates against the current date given above ("today", "tomorrow", "June 20" = its next future occurrence). A month WITH a year = the 1st of that month; a month WITHOUT a year = the 1st of its next future occurrence. CONFLICT RULE: if the request contains BOTH a relative day word ("today", "tomorrow") AND an explicit calendar date, and they do not refer to the same day, set start_date null AND date_conflict true — a conflict must be clarified, never silently resolved to either date. A date that is simply not mentioned is NOT a conflict: start_date null, date_conflict false.
- Entities stated in EARLIER turns carry over; later turns only override what they explicitly change. For a refinement, return the already-established entities.
- Never guess: a value that is not stated, not in a photo, and not carried over is null. Returning null is always safer than guessing — null triggers one clarifying question; a guess produces a wrong trip.

Examples (assume today is 2026-06-11):
- "kinderdijk today cycling trip from Amsterdam from June 20" → {"intent":"new_trip","in_scope":true,"start_location":"Amsterdam","days":null,"start_date":null,"date_conflict":true}  (no length stated; "today" conflicts with "June 20")
- "Plan a one-day trip from Utrecht tomorrow" → {"intent":"new_trip","in_scope":true,"start_location":"Utrecht","days":1,"start_date":"2026-06-12","date_conflict":false}
- "Plan a one-day trip from Utrecht" → {"intent":"new_trip","in_scope":true,"start_location":"Utrecht","days":1,"start_date":null,"date_conflict":false}  (no date mentioned — not a conflict)
- "make day 2 a bit shorter" (after a 2-day Arnhem trip starting 2026-06-13 was discussed) → {"intent":"refinement","in_scope":true,"start_location":"Arnhem","days":2,"start_date":"2026-06-13","date_conflict":false}
- "I don't care, just plan something nice" (replying to a question about start/length) → {"intent":"new_trip","in_scope":true,"start_location":null,"days":null,"start_date":null,"date_conflict":false}  (a refusal continues the trip request; it does not change intent)`;

// --- pure helpers (unit-tested offline) ---------------------------------

export const ENTITY_LABELS = {
  start_location: "start location",
  days: "trip length",
  start_date: "start date",
} as const;

export function missingEntities(e: TripEntities): string[] {
  const missing: string[] = [];
  if (!e.start_location) missing.push(ENTITY_LABELS.start_location);
  if (!e.days) missing.push(ENTITY_LABELS.days);
  if (!e.start_date) missing.push(ENTITY_LABELS.start_date);
  return missing;
}

export function gateDecision(x: IntakeExtraction): { gate: boolean; missing: string[] } {
  // What blocks planning: missing start, missing length, or a date CONFLICT.
  // A merely absent date does not gate — it defaults to tomorrow and the plan
  // discloses the assumption (see applyDefaultEntities / confirmedParamsLine).
  const missing: string[] = [];
  if (!x.start_location) missing.push(ENTITY_LABELS.start_location);
  if (!x.days) missing.push(ENTITY_LABELS.days);
  if (x.date_conflict) missing.push(ENTITY_LABELS.start_date);
  // Only a new, in-scope trip request is gated. Refinements and out-of-scope
  // requests go straight to the agent (which redirects non-NL requests itself).
  return { gate: x.in_scope && x.intent === "new_trip" && missing.length > 0, missing };
}

// The clarifying question is deterministic (templated, not model-written): it
// always names exactly the missing parameters, so behavior is testable and
// the gate can never wander into planning.
export function buildIntakeQuestion(missing: string[], e: TripEntities): string {
  const known: string[] = [];
  if (e.start_location) known.push(`start: **${e.start_location}**`);
  if (e.days) known.push(`length: **${e.days} day${e.days > 1 ? "s" : ""}**`);
  if (e.start_date) known.push(`start date: **${e.start_date}**`);

  const asks: Record<string, string> = {
    [ENTITY_LABELS.start_location]: "**Where does the ride start?** A city or town — or send a photo of the place.",
    [ENTITY_LABELS.days]: "**How many days?** (1–3)",
    [ENTITY_LABELS.start_date]: "**Which date counts?** You mentioned two different dates — tell me the one you're setting off, so I check the right weather.",
  };

  const ack = known.length ? `Got it so far — ${known.join(", ")}.\n\n` : "";
  const need = missing.length === 1 ? "one more thing" : `${missing.length} quick things`;
  return `${ack}Before I plan anything, I need ${need}:\n${missing.map((m) => `- ${asks[m]}`).join("\n")}\n\nPrefer to leave it to me? Just say so — I'll assume a 1-day trip from Amsterdam starting tomorrow.`;
}

// Tomorrow in the trip's timezone — the date default when the user declines to
// give one (same anchor logic as currentDateLine in system-prompt.ts).
export function tomorrowAmsterdam(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString("en-CA", {
    timeZone: "Europe/Amsterdam",
  });
}

// Refusal fallback: fill whatever is still open with the stated defaults and
// report which fields were assumed (the plan must disclose them).
export function applyDefaultEntities(e: TripEntities): { entities: TripEntities; assumed: string[] } {
  const assumed = missingEntities(e);
  return {
    entities: {
      start_location: e.start_location ?? "Amsterdam",
      days: e.days ?? 1,
      start_date: e.start_date ?? tomorrowAmsterdam(),
    },
    assumed,
  };
}

// Defensive normalization of model JSON, then schema enforcement. The lenient
// pass coerces junk to null — null means "ask the user" downstream, always the
// safe direction (a guess produces a wrong trip; null produces one question).
// Value.Check then asserts the result actually satisfies the published schema,
// so no consumer can ever see an out-of-contract object.
export function normalizeExtraction(raw: any): IntakeExtraction {
  const days = Number(raw?.days);
  const date = typeof raw?.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.start_date.trim())
    ? raw.start_date.trim()
    : null;
  const candidate: IntakeExtraction = {
    intent: raw?.intent === "refinement" || raw?.intent === "other" ? raw.intent : "new_trip",
    in_scope: raw?.in_scope !== false,
    start_location:
      typeof raw?.start_location === "string" && raw.start_location.trim() ? raw.start_location.trim() : null,
    days: Number.isInteger(days) && days >= 1 && days <= 14 ? days : null,
    start_date: date,
    // A resolved date can't conflict — the flag only holds when no date stands.
    date_conflict: raw?.date_conflict === true && date === null,
  };
  if (!Value.Check(IntakeExtractionSchema, candidate)) {
    const [first] = Value.Errors(IntakeExtractionSchema, candidate);
    throw new Error(`intake extraction violates schema at ${first?.instancePath}: ${first?.message}`);
  }
  return candidate;
}

// Injected into the planning turn once the gate passes, so the agent treats
// the three parameters as settled facts (see system prompt). When some were
// assumed, the pipeline itself pins an assumptionNotice above the reply
// (deterministic — not left to the model), so the agent must NOT restate it.
export function confirmedParamsLine(e: TripEntities, assumed: string[] = []): string {
  const base = `[Confirmed trip parameters — start: ${e.start_location}; length: ${e.days} day(s); start date: ${e.start_date}. These are settled: do not re-ask or change them.`;
  if (!assumed.length) return `${base}]`;
  return `${base} The user did not specify ${assumed.join(", ")} — these are ASSUMED defaults. A notice stating the assumption is already pinned above your reply: do NOT restate it, start directly with the plan.]`;
}

// Identifying a start location from a PHOTO is a guess — different Dutch canal
// towns (Groningen vs Dokkum, Delft vs Leiden) look alike to a vision model, and
// a wrong guess silently propagates to every later turn. So the plan discloses
// the identification for confirmation instead of committing to it silently. Pinned
// by the pipeline as the first line, same mechanism as assumptionNotice.
export function photoConfirmNotice(location: string): string {
  return `*It looks like this photo is **${location}**, so I've planned the trip starting there. If that's not the right place, just tell me the correct city and I'll re-plan.*`;
}

// The disclosure pinned by the pipeline as the first line of a plan built on
// assumed parameters ("state it on top" is a hard product rule — so it is done
// in code, not delegated to the model).
export function assumptionNotice(e: TripEntities, assumed: string[]): string {
  const bits: string[] = [];
  if (assumed.includes(ENTITY_LABELS.days)) bits.push(`a ${e.days}-day trip`);
  if (assumed.includes(ENTITY_LABELS.start_location)) bits.push(`from ${e.start_location}`);
  if (assumed.includes(ENTITY_LABELS.start_date)) bits.push(`starting ${e.start_date}${e.start_date === tomorrowAmsterdam() ? " (tomorrow)" : ""}`);
  return `*Assuming ${bits.join(", ")} — say the word to change any of these.*`;
}

// --- the extraction call -------------------------------------------------

export async function extractIntake(turns: UserTurn[]): Promise<IntakeExtraction> {
  const content: any[] = [];
  let hasImages = false;
  for (const turn of turns) {
    if (turn.text.trim()) content.push({ type: "text", text: `USER TURN: ${turn.text}` });
    for (const img of turn.images ?? []) {
      hasImages = true;
      content.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
    }
  }
  if (!content.length) content.push({ type: "text", text: "USER TURN: (empty)" });

  // Identifying a city from a photo is a vision task the small default model
  // (Haiku) is weak at — it confidently misnames Dutch canal towns (and even
  // returns foreign cities). When an image is present, use a stronger vision
  // model (VISION_MODEL, default Gemini 2.5 Flash — good at landmarks, cheap, same
  // OpenRouter key). Text-only intake stays on the fast default model.
  const model = hasImages
    ? (process.env.VISION_MODEL ?? "google/gemini-2.5-flash")
    : (process.env.INTAKE_MODEL ?? process.env.MODEL ?? DEFAULT_MODEL);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: `${EXTRACTION_SYSTEM}\n\n${currentDateLine()}` },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`intake extraction failed: ${res.status} ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const out: string = data.choices?.[0]?.message?.content ?? "";
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`intake extraction returned no JSON: ${out.slice(0, 150)}`);
  return normalizeExtraction(JSON.parse(out.slice(start, end + 1)));
}