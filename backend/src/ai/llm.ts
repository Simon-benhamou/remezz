import OpenAI from "openai";
import { getConfig } from "../utils/env.js";
import { incAICall } from "../metrics/aiCalls.js";

export type LLMChoice = "openai" | "grok" | "none";

function pickLLM(): LLMChoice {
  const cfg = getConfig();
  if (cfg.OPENAI_API_KEY) return "openai";
  if (cfg.USE_GROK && cfg.GROK_API_KEY) return "grok";
  return "none";
}

export async function llmJSON(prompt: string): Promise<string> {
  const which = pickLLM();
  incAICall();
  if (which === "openai") return callOpenAI(prompt);
  if (which === "grok") return callGrok(prompt);
  throw new Error("No LLM configured (OPENAI_API_KEY or GROK_API_KEY missing).");
}

async function callOpenAI(prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: getConfig().OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini", // efficient; switch to gpt-4o if needed
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You are a trading strategy assistant. Output strictly valid JSON." },
      { role: "user", content: prompt },
    ],
  });
  const msg = resp.choices[0]?.message?.content?.trim() || "{}";
  return msg;
}

// NB: Grok: on passe par HTTP générique. Ajuste GROK endpoint si besoin.
// Par défaut, beaucoup utilisent `https://api.x.ai/v1/chat/completions`.
async function callGrok(prompt: string): Promise<string> {
  const { GROK_API_KEY } = getConfig();
  const endpoint = process.env.GROK_BASE_URL || "https://api.x.ai/v1/chat/completions";
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-2",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a trading strategy assistant. Output strictly valid JSON." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Grok HTTP ${r.status}`);
  const j = await r.json();
  const content = j?.choices?.[0]?.message?.content?.trim() || "{}";
  return content;
}
