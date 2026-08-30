#!/usr/bin/env node
/**
 * Harness de avaliacao (evals) dos agentes Synexa.
 *
 * Modos:
 *   node evals/run-evals.mjs --dry   (default)  Roda os casos deterministicos e
 *                                               compara respostas de LLM gravadas
 *                                               em fixtures/ (regressao de prompts
 *                                               sem custo de API).
 *   node evals/run-evals.mjs --live              Chama o provedor real (requer
 *                                               EVALS_API_KEY / EVALS_PROVIDER /
 *                                               EVALS_MODEL). Grava fixtures novas
 *                                               (fixture_source: "recorded").
 *
 * Casos: evals/cases/*.json  ->  { id, description, kind, system_prompt, user,
 *   context?, tools?, scorers: [{type, ...}], fixture? }
 * Scorers: contains_any, contains_all, not_contains, regex, word_count_max,
 *          json_valid, json_fields, grounded_in_context, max_latency_ms.
 *
 * Saida: console + evals/results/report-<timestamp>.json
 * Exit: 0 se tudo passa, 1 se ha falhas (usavel em CI).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(__dirname, 'cases');
const FIXTURES_DIR = join(__dirname, 'fixtures');
const RESULTS_DIR = join(__dirname, 'results');

const LIVE = process.argv.includes('--live');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const PROVIDER = (process.env.EVALS_PROVIDER || 'gemini').toLowerCase();
const MODEL = process.env.EVALS_MODEL || 'gemini-2.0-flash';
const API_KEY = process.env.EVALS_API_KEY || '';

// ── Scorers ─────────────────────────────────────────────────────────────
function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function runScorer(scorer, output, ctx) {
  const text = String(output ?? '');
  switch (scorer.type) {
    case 'contains_any': {
      const hits = scorer.values.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
      return { pass: hits.length > 0, detail: `encontrado: ${hits.join(', ') || 'nenhum'}` };
    }
    case 'contains_all': {
      const missing = scorer.values.filter((v) => !text.toLowerCase().includes(v.toLowerCase()));
      return { pass: missing.length === 0, detail: missing.length ? `faltando: ${missing.join(', ')}` : 'todos presentes' };
    }
    case 'not_contains': {
      const bad = scorer.values.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
      return { pass: bad.length === 0, detail: bad.length ? `proibido presente: ${bad.join(', ')}` : 'ok' };
    }
    case 'regex': {
      const re = new RegExp(scorer.pattern, scorer.flags || 'i');
      return { pass: re.test(text), detail: `pattern=${scorer.pattern}` };
    }
    case 'word_count_max': {
      const n = wordCount(text);
      return { pass: n <= scorer.max, detail: `${n} palavras (max ${scorer.max})` };
    }
    case 'json_valid': {
      try {
        JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
        return { pass: true, detail: 'json valido' };
      } catch (e) {
        return { pass: false, detail: `json invalido: ${e.message}` };
      }
    }
    case 'json_fields': {
      try {
        const obj = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
        const missing = (scorer.fields || []).filter((f) => !(f in obj));
        return { pass: missing.length === 0, detail: missing.length ? `faltando campos: ${missing.join(', ')}` : 'ok' };
      } catch (e) {
        return { pass: false, detail: `json invalido: ${e.message}` };
      }
    }
    case 'grounded_in_context': {
      // Heuristica anti-alucinacao: toda entidade Listada como proibida NAO pode
      // aparecer; o output deve citar apenas termos do contexto (amostragem).
      const outputLower = text.toLowerCase();
      const hallucinated = (scorer.forbidden_entities || []).filter((e) =>
        outputLower.includes(String(e).toLowerCase()),
      );
      return {
        pass: hallucinated.length === 0,
        detail: hallucinated.length ? `entidades fora do contexto: ${hallucinated.join(', ')}` : 'ok',
      };
    }
    case 'max_latency_ms': {
      const latency = ctx.latencyMs ?? 0;
      return { pass: latency <= scorer.max, detail: `${latency}ms (max ${scorer.max})` };
    }
    default:
      return { pass: false, detail: `scorer desconhecido: ${scorer.type}` };
  }
}

// ── Chamada ao LLM (modo live) ──────────────────────────────────────────
async function callLLM(liveParams) {
  const { system_prompt: systemPrompt, user, context, latencyStart } = liveParams;
  const userText = context ? `${user}\n\n<contexto>\n${context}\n</contexto>` : user;

  if (PROVIDER === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { temperature: 0 },
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') ?? '';
    return { text, latencyMs: Date.now() - latencyStart, usage: data.usageMetadata || null };
  }

  if (PROVIDER === 'openrouter' || PROVIDER === 'groq' || PROVIDER === 'openai') {
    const baseUrl =
      PROVIDER === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : PROVIDER === 'groq' ? 'https://api.groq.com/openai/v1'
      : 'https://api.openai.com/v1';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${PROVIDER} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      latencyMs: Date.now() - latencyStart,
      usage: data.usage || null,
    };
  }

  throw new Error(`provedor nao suportado: ${PROVIDER}`);
}

// ── Main ────────────────────────────────────────────────────────────────
function loadCases() {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      let caseDef;
      try {
        caseDef = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        throw new Error(`JSON invalido em evals/cases/${f}: ${e.message}`);
      }
      caseDef._file = f;
      return caseDef;
    });
}

async function main() {
  const cases = loadCases().filter((c) => !ONLY || c.id === ONLY);
  if (cases.length === 0) {
    console.error('Nenhum caso encontrado em evals/cases/');
    process.exit(1);
  }

  if (LIVE && !API_KEY) {
    console.error('Modo --live requer EVALS_API_KEY no ambiente.');
    process.exit(1);
  }

  mkdirSync(FIXTURES_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const results = [];
  let failed = 0;

  for (const c of cases) {
    const fixturePath = join(FIXTURES_DIR, `${c.id}.json`);
    let output = null;
    let latencyMs = null;
    let usage = null;
    let mode = 'dry-fixture';

    if (LIVE) {
      const started = Date.now();
      try {
        const res = await callLLM({
          system_prompt: c.system_prompt,
          user: c.user,
          context: c.context,
          latencyStart: started,
        });
        output = res.text;
        latencyMs = res.latencyMs;
        usage = res.usage;
        mode = 'live';
        writeFileSync(
          fixturePath,
          JSON.stringify({ output, fixture_source: 'recorded', recorded_at: new Date().toISOString(), model: MODEL }, null, 2),
        );
      } catch (e) {
        results.push({ id: c.id, status: 'error', error: e.message });
        failed++;
        continue;
      }
    } else if (existsSync(fixturePath)) {
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      output = fixture.output;
      mode = `dry (${fixture.fixture_source || 'fixture'})`;
    } else {
      results.push({ id: c.id, status: 'no-fixture', note: 'rode com --live para gravar' });
      failed++;
      continue;
    }

    const scorerResults = (c.scorers || []).map((s) => ({
      type: s.type,
      ...runScorer(s, output, { latencyMs }),
    }));
    const pass = scorerResults.every((r) => r.pass);
    if (!pass) failed++;

    results.push({
      id: c.id,
      description: c.description,
      status: pass ? 'pass' : 'fail',
      mode,
      latency_ms: latencyMs,
      usage,
      output_preview: String(output).slice(0, 300),
      scorers: scorerResults,
    });

    const icon = pass ? 'PASS' : 'FAIL';
    console.log(`[${icon}] ${c.id} (${mode})`);
    for (const s of scorerResults) {
      console.log(`        ${s.pass ? 'ok ' : 'X  '} ${s.type}: ${s.detail}`);
    }
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: LIVE ? 'live' : 'dry',
    provider: LIVE ? `${PROVIDER}/${MODEL}` : null,
    total: results.length,
    failed,
    results,
  };
  const reportPath = join(RESULTS_DIR, `report-${Date.now()}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nTotal: ${results.length} | Falhas: ${failed}`);
  console.log(`Relatorio: ${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
