// Optional server-side speech-to-text, off by default. The browser's Web Speech
// API (the default voice path in app.js) is mediocre and mishears even English
// trip requests ("plan a 2-day" → "Planet today"). This module swaps in a real
// transcriber, selected by STT_BACKEND:
//
//   "browser"  (default) — no server STT; the frontend uses the Web Speech API.
//   "gemini"             — transcribe with an audio-capable chat model through
//                          the SAME OpenRouter key the planner already uses
//                          (no new vendor). Domain-biased via a system prompt.
//   "deepgram"           — transcribe with Deepgram's dedicated STT API
//                          (DEEPGRAM_API_KEY). Domain-biased via keyword hints.
//
// Both server backends share one contract: take a base64 audio clip + its mime
// and return plain text. The transcript re-enters the normal text prompt path,
// so every grounding rule applies to it exactly as to typed input. The frontend
// encodes the clip to WAV before upload, so each backend gets a format it
// accepts regardless of the browser's native recording codec.

export type SttBackend = "browser" | "gemini" | "deepgram";

export function sttBackend(): SttBackend {
  const b = (process.env.STT_BACKEND ?? "browser").toLowerCase();
  return b === "gemini" || b === "deepgram" ? b : "browser";
}

export interface AudioUpload {
  data: string; // base64 (no data: prefix)
  mimeType: string;
}

// ~9.5 MB of base64 (~7 MB binary) — minutes of WAV speech, well under the
// route's 10 MB JSON cap, low enough to bound a hostile upload.
const MAX_AUDIO_BASE64 = 9_500_000;

// Bounds the untrusted /transcribe body — mirrors sanitizeImages for images.
export function validateAudio(data: unknown, mimeType: unknown): AudioUpload | null {
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_AUDIO_BASE64) return null;
  if (typeof mimeType !== "string" || !mimeType.toLowerCase().startsWith("audio/")) return null;
  return { data, mimeType };
}

// Domain vocabulary both backends bias toward — the words browser STT most often
// mangles in this app. Gemini gets them as prose; Deepgram as keyword hints.
const DOMAIN_TERMS = [
  "Amsterdam", "Utrecht", "Rotterdam", "Den Haag", "Haarlem", "Leiden", "Kinderdijk", "Keukenhof",
  "Veluwe", "Zeeland", "Friesland", "IJsselmeer", "knooppunten", "fietspad", "e-bike",
];

// --- dispatcher ----------------------------------------------------------

export async function transcribeAudio(audio: AudioUpload): Promise<string> {
  return sttBackend() === "deepgram" ? transcribeDeepgram(audio) : transcribeGemini(audio);
}

// --- Gemini via OpenRouter ----------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Any audio-capable model on OpenRouter works; Gemini Flash is cheap, fast, and
// strong on multilingual/place-name audio. Overridable, same key either way.
const GEMINI_MODEL = process.env.STT_MODEL ?? "google/gemini-2.5-flash";

// A chat LLM used as a transcriber will CONFABULATE a plausible sentence when
// the audio has no speech — especially if the prompt primes it with a task
// ("you plan cycling trips, expect requests like…"). Two guards, both verified
// against silence/tone clips: (1) a neutral transcriber framing with domain
// terms scoped strictly to *disambiguation* ("do NOT add them otherwise"), and
// (2) a <NO_SPEECH> sentinel for non-speech, which we map to "" — far more
// reliable than asking for an empty string, which the model resists emitting.
const NO_SPEECH = "<NO_SPEECH>";
const GEMINI_SYSTEM = `Transcribe the audio to text, VERBATIM, in the language spoken. Output ONLY the literal words spoken — no quotes, no commentary, no translation.
Dutch cycling place/terms that may occur (use ONLY to disambiguate an acoustically unclear word — never add them otherwise): ${DOMAIN_TERMS.join(", ")}.
If the audio has no intelligible speech (silence, a tone, noise, music), output exactly ${NO_SPEECH} and nothing else. NEVER invent, guess, or complete a plausible request — a fabricated transcript produces a wrong trip.`;

// container mime → the `format` token OpenRouter's input_audio expects.
const FORMAT_BY_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

async function transcribeGemini(audio: AudioUpload): Promise<string> {
  const base = audio.mimeType.split(";")[0].trim().toLowerCase();
  const format = FORMAT_BY_MIME[base] ?? "wav";

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: GEMINI_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Transcribe this audio." },
            { type: "input_audio", input_audio: { data: audio.data, format } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`STT (gemini) ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? "";
  const text = typeof content === "string" ? content.trim() : "";
  // Map the non-speech sentinel (and a model that wraps it in prose) to empty.
  return text === NO_SPEECH || text.includes(NO_SPEECH) ? "" : text;
}

// --- Deepgram ------------------------------------------------------------

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL ?? "nova-2";

async function transcribeDeepgram(audio: AudioUpload): Promise<string> {
  if (!process.env.DEEPGRAM_API_KEY) throw new Error("STT (deepgram): DEEPGRAM_API_KEY is not set");

  const params = new URLSearchParams({ model: DEEPGRAM_MODEL, smart_format: "true", punctuate: "true" });
  // Optional locale hint (e.g. STT_LANGUAGE=en or nl); Deepgram auto-detects otherwise.
  if (process.env.STT_LANGUAGE) params.set("language", process.env.STT_LANGUAGE);
  // Vocabulary biasing: nova-2 takes repeated `keywords`. The `:2` boosts weight.
  for (const term of DOMAIN_TERMS) params.append("keywords", `${term}:2`);

  const res = await fetch(`${DEEPGRAM_URL}?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": audio.mimeType,
    },
    body: Buffer.from(audio.data, "base64"),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`STT (deepgram) ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  return typeof transcript === "string" ? transcript.trim() : "";
}