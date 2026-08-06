// Bring-your-own-key LLM access for `agent` routes — docs/routes.md.
//
// Zero npm dependencies, like the rest of api-local: this talks raw HTTP to a model API
// with global fetch, the same way smarthost.mjs talks raw SMTP with node:net. A vendor
// SDK per provider would be four dependency trees to serve four POST requests.
//
// Three wire formats cover essentially every major provider, because most of them speak
// OpenAI's chat-completions shape:
//
//   anthropic          Anthropic Messages API          Claude
//   gemini             Google generateContent          Gemini
//   openai-compatible  OpenAI chat/completions         OpenAI, OpenRouter (~300 models
//                                                      behind one key), Groq, Mistral,
//                                                      Together, xAI, DeepSeek, Azure,
//                                                      Ollama / vLLM / LM Studio
//
// Deliberately NON-streaming and tool-free. A route's agent runs in the background after
// ingest has already answered the edge, so there is no UI waiting on tokens; and it needs
// exactly one JSON decision back, not an agentic loop. See docs/routes.md §5.1 for why
// "no tools" is a security property here and not just a simplification.

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The providers a route may name. `custom` carries no baseUrl of its own — the operator
 * supplies one, which is what makes self-hosted models (Ollama, vLLM, LM Studio) and
 * Azure deployments reachable without new code here.
 */
export const PROVIDERS = {
  anthropic:  { label: 'Anthropic (Claude)', wire: 'anthropic', defaultModel: 'claude-sonnet-4-6' },
  gemini:     { label: 'Google Gemini',      wire: 'gemini',    defaultModel: 'gemini-2.5-flash' },
  openai:     { label: 'OpenAI',             wire: 'openai',    baseUrl: 'https://api.openai.com/v1',      defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter',         wire: 'openai',    baseUrl: 'https://openrouter.ai/api/v1',   defaultModel: 'openai/gpt-4o-mini' },
  groq:       { label: 'Groq',               wire: 'openai',    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  mistral:    { label: 'Mistral',            wire: 'openai',    baseUrl: 'https://api.mistral.ai/v1',      defaultModel: 'mistral-small-latest' },
  together:   { label: 'Together',           wire: 'openai',    baseUrl: 'https://api.together.xyz/v1',    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  xai:        { label: 'xAI (Grok)',         wire: 'openai',    baseUrl: 'https://api.x.ai/v1',            defaultModel: 'grok-2-latest' },
  deepseek:   { label: 'DeepSeek',           wire: 'openai',    baseUrl: 'https://api.deepseek.com/v1',    defaultModel: 'deepseek-chat' },
  custom:     { label: 'Custom (OpenAI-compatible)', wire: 'openai', defaultModel: '' },
};

/** The ids a route's ai_provider may hold — also what the console renders its dropdown from. */
export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * Validate a provider choice, returning { provider, baseUrl, model } or { error }.
 * Shared by the admin API (on write) and the runner (on read), so a route that stored
 * cleanly can't fail differently at run time.
 */
export function resolveProvider({ provider, baseUrl = null, model = null }) {
  const spec = PROVIDERS[provider];
  if (!spec) return { error: `unknown AI provider "${provider}" (expected one of: ${PROVIDER_IDS.join(', ')})` };
  const url = (baseUrl || spec.baseUrl || '').trim().replace(/\/+$/, '');
  if (spec.wire === 'openai' && !url) {
    return { error: `provider "${provider}" needs a base URL (e.g. http://localhost:11434/v1)` };
  }
  const chosen = (model || spec.defaultModel || '').trim();
  if (!chosen) return { error: `provider "${provider}" needs a model name` };
  return { provider, wire: spec.wire, baseUrl: url, model: chosen };
}

/** Redact a credential anywhere it might have been echoed into an error body. */
function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(secret).join('«redacted»') : s;
}

async function postJson(url, headers, body, { timeoutMs, apiKey }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `AI request timed out after ${timeoutMs}ms` : `AI request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    // The key can appear in a provider's echoed request; never let it reach a log or the console.
    throw new Error(`AI provider HTTP ${res.status}: ${redact(text, apiKey).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`AI provider returned non-JSON: ${redact(text, apiKey).slice(0, 200)}`);
  }
}

/**
 * One completion. Returns the model's raw text.
 *
 * @param {object} o
 * @param {string} o.provider   a key of PROVIDERS
 * @param {string} o.apiKey     the operator's key for that provider
 * @param {string} o.system     system instructions
 * @param {string} o.userText   the user-role content
 */
export async function complete({ provider, apiKey, system, userText, baseUrl = null, model = null,
                                 maxTokens = 1024, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const spec = resolveProvider({ provider, baseUrl, model });
  if (spec.error) throw new Error(spec.error);
  if (!apiKey) throw new Error(`no API key configured for provider "${provider}"`);
  const opts = { timeoutMs, apiKey };

  if (spec.wire === 'anthropic') {
    const data = await postJson('https://api.anthropic.com/v1/messages', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }, {
      model: spec.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }, opts);
    return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  if (spec.wire === 'gemini') {
    // Gemini takes the key as a header (not a query param — that leaks into access logs)
    // and the system prompt as its own top-level field.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(spec.model)}:generateContent`;
    const data = await postJson(url, { 'x-goog-api-key': apiKey }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }, opts);
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }

  const data = await postJson(`${spec.baseUrl}/chat/completions`, {
    authorization: `Bearer ${apiKey}`,
  }, {
    model: spec.model,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userText }],
  }, opts);
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * Pull the decision object out of a model's reply.
 *
 * Models wrap JSON in prose or fences no matter how firmly the prompt says not to, so we
 * take the first balanced {...} span rather than trusting the whole string to parse. An
 * unparseable reply is NOT an error — it becomes `none`, which is the safe default: doing
 * nothing is always an acceptable outcome for an inbound agent.
 */
export function parseDecision(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return { action: 'none' };
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const o = JSON.parse(s.slice(start, i + 1));
        const action = o.action === 'reply' || o.action === 'forward' ? o.action : 'none';
        return {
          action,
          to: typeof o.to === 'string' ? o.to : null,
          subject: typeof o.subject === 'string' ? o.subject : null,
          body: typeof o.body === 'string' ? o.body : '',
        };
      } catch {
        return { action: 'none' };
      }
    }
  }
  return { action: 'none' };
}
