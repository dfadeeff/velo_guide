// The single shared conversation pipeline used by the web server, the smoke
// harness, and the eval runner — so what gets evaluated is exactly what runs
// in production, and the turn logic exists in one place instead of three.
// A pipeline instance is long-lived: it holds a persistent agent session and
// processes every turn of a multi-turn conversation.
//
// Each turn flows: intake gate → (clarifying question | planning agent + guards).
//
//   1. INTAKE GATE (intake.ts). A tool-free extraction resolves the three
//      required parameters — start location (text or photo), days, start date.
//      If any is missing or conflicting on a new trip request, the turn ends
//      HERE with one targeted question: session.prompt() is never reached, so
//      it is structurally impossible to plan on guessed parameters. Refinement
//      turns and out-of-scope requests bypass the gate. The gate asks at most
//      ONCE: if the user's reply still leaves parameters open (refusal,
//      "just plan something"), stated defaults fill the gaps — 1 day /
//      Amsterdam / tomorrow — and the plan opens by disclosing them.
//   2. PLANNING TURN. Gated turns are buffered; when the gate finally passes,
//      the buffered context (texts + images, e.g. the photo that named the
//      start city) plus the confirmed-parameters line goes to the agent in one
//      prompt.
//   3. RELIABILITY GUARDS. Premature stop (tool data gathered, no itinerary
//      text) → one synthesis re-prompt. Post-gate clarification loop (zero
//      tools + an asking reply) → discard + one answer-first re-prompt.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createVeloGuideSession } from "./agent.js";
import {
  CLARIFICATION_PATTERN,
  CLARIFICATION_REPROMPT,
  FAST_MODE_INSTRUCTION,
  SYNTHESIS_REPROMPT,
} from "./system-prompt.js";
import {
  applyDefaultEntities,
  assumptionNotice,
  buildIntakeQuestion,
  confirmedParamsLine,
  extractIntake,
  gateDecision,
  type IntakeExtraction,
  type UserTurn,
} from "./intake.js";
import type { ImageInput } from "./utils/images.js";

export type PipelineEvent =
  | { type: "delta"; text: string }
  | { type: "reset" } // streamed text so far was preamble/withdrawn — discard it
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; result?: unknown };

export interface TurnInput {
  text: string;
  images?: ImageInput[];
  fast?: boolean; // compact plans, batched tool calls (default true — mirrors the web UI)
}

export interface TurnOutcome {
  kind: "clarification" | "plan";
  text: string;
  toolCalls: string[];
  intake?: IntakeExtraction;
}

export interface PipelineOptions {
  model?: string;
  onEvent?: (event: PipelineEvent) => void;
  // Raw pi-agent session events, for diagnostics (smoke trace). Pipeline
  // consumers should prefer onEvent.
  onSessionEvent?: (event: AgentSessionEvent) => void;
}

export async function createVeloGuidePipeline(opts: PipelineOptions = {}) {
  const session = await createVeloGuideSession({ model: opts.model });
  const emit = (e: PipelineEvent) => opts.onEvent?.(e);

  // Per-turn tracking for the guards; reset at each prompt.
  let turnText = "";
  let turnToolCalls: string[] = [];
  // Pinned first line of a plan built on assumed parameters. Re-seeded after
  // every narration-strip reset, so it deterministically survives as the top
  // of the final reply — disclosure is a product rule, not a model behavior.
  let turnPreamble = "";

  const resetTurnText = () => {
    emit({ type: "reset" });
    turnText = turnPreamble ? `${turnPreamble}\n\n` : "";
    if (turnText) emit({ type: "delta", text: turnText });
  };

  // Full user-turn history feeds the extractor (entities carry across turns);
  // pending* buffers hold gated turns until the gate passes.
  const userTurns: UserTurn[] = [];
  let pendingTexts: string[] = [];
  let pendingImages: ImageInput[] = [];
  // Ask-once latch for the current trip request; cleared after a planning turn
  // so the NEXT new-trip request gets its own question.
  let askedIntake = false;

  session.subscribe((event: AgentSessionEvent) => {
    opts.onSessionEvent?.(event);

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      turnText += event.assistantMessageEvent.delta;
      emit({ type: "delta", text: event.assistantMessageEvent.delta });
    }
    if (event.type === "tool_execution_start") {
      // The agent gathers ALL data before writing the itinerary, so any text
      // streamed before a tool runs is planning preamble — withdraw it (and
      // re-pin the assumption notice, if any).
      turnToolCalls.push(event.toolName);
      resetTurnText();
      emit({ type: "tool_start", name: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      emit({ type: "tool_end", name: event.toolName, result: event.result });
    }
  });

  async function promptWithGuards(text: string, images: ImageInput[] | undefined, isNewTrip: boolean): Promise<void> {
    turnToolCalls = [];
    turnText = turnPreamble ? `${turnPreamble}\n\n` : "";
    if (turnText) emit({ type: "delta", text: turnText });
    await session.prompt(text, { images: images?.length ? images : undefined });

    // A new trip that never reached plan_route and ends in a question is a
    // stalled plan (e.g. a garbled voice token failed to geocode and the model
    // asked about it instead of planning around it) — same violation as a
    // zero-tool clarification.
    const stalledNewTrip =
      isNewTrip && !turnToolCalls.includes("plan_route") && /\?[\s*_]*$/.test(turnText.trim());

    // The pinned notice doesn't count as model output for the empty-turn check.
    const modelText = turnPreamble ? turnText.replace(turnPreamble, "") : turnText;
    if (modelText.trim().length < 20) {
      // Premature stop: data gathered but no itinerary written.
      await session.prompt(SYNTHESIS_REPROMPT);
    } else if ((turnToolCalls.length === 0 && CLARIFICATION_PATTERN.test(turnText)) || stalledNewTrip) {
      // Post-gate clarification loop: parameters are settled upstream, so an
      // asking reply instead of a plan is a policy violation — withdraw it
      // and re-prompt once.
      resetTurnText();
      await session.prompt(CLARIFICATION_REPROMPT);
    }
  }

  async function runTurn(input: TurnInput): Promise<TurnOutcome> {
    const fast = input.fast !== false;
    userTurns.push({ text: input.text, images: input.images });

    // Intake gate. Extraction failure is survivable: fall through to the agent,
    // whose fallback defaults still produce a plan (graceful degradation beats
    // a hard error for the user).
    let intake: IntakeExtraction | undefined;
    try {
      intake = await extractIntake(userTurns);
    } catch (err: any) {
      console.error(`intake extraction failed (${err.message}) — proceeding with agent defaults`);
    }

    // If the previous turn was our intake question, this reply continues the
    // same new-trip request no matter how the extractor classifies it ("just
    // plan something" reads as "other" to a classifier, but it is a refusal
    // answer) — coerce deterministically so the params line is always injected.
    if (intake && askedIntake) intake = { ...intake, intent: "new_trip" };

    let assumed: string[] = [];
    if (intake) {
      const { gate, missing } = gateDecision(intake);
      if (gate && !askedIntake) {
        askedIntake = true;
        pendingTexts.push(input.text);
        if (input.images) pendingImages.push(...input.images);
        const question = buildIntakeQuestion(missing, intake);
        emit({ type: "delta", text: question });
        return { kind: "clarification", text: question, toolCalls: [], intake };
      }
      if (intake.intent === "new_trip") {
        // Whatever is still open gets a stated default the plan must disclose:
        // the date when it simply wasn't given (assume tomorrow — never worth a
        // question), or everything after the user declined the one question.
        const fallback = applyDefaultEntities(intake);
        intake = { ...intake, ...fallback.entities };
        assumed = fallback.assumed;
      }
    }

    // Gate passed (or bypassed): hand the agent everything it hasn't seen yet —
    // buffered gated turns first, so e.g. the photo that named the start city
    // reaches the planner alongside the answer that completed the parameters.
    const parts = [...pendingTexts, input.text];
    if (intake?.intent === "new_trip") parts.push(confirmedParamsLine(intake, assumed));
    if (fast) parts.push(FAST_MODE_INSTRUCTION);
    const images = [...pendingImages, ...(input.images ?? [])];
    pendingTexts = [];
    pendingImages = [];
    turnPreamble = intake && assumed.length ? assumptionNotice(intake, assumed) : "";

    await promptWithGuards(parts.filter(Boolean).join("\n\n"), images, intake?.intent === "new_trip");
    askedIntake = false;
    return { kind: "plan", text: turnText, toolCalls: [...turnToolCalls], intake };
  }

  return {
    runTurn,
    dispose: () => session.dispose(),
  };
}