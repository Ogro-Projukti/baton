import type { Disposable, SecretStorage } from 'vscode';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ZodType, ZodTypeDef } from 'zod';
import { preferredKey } from '../secrets';
import { loadAvailability, loadKB } from '../kb/store';
import { researchAgents } from '../kb/research';
import type { Candidate } from '../kb/research';
import type { KnowledgeBase } from '../kb/types';
import type { Route } from '../types';
import { RouteSchema, RouterResult } from '../types';
import { routeGemma } from './gemma';
import { callGemmaJsonWithKey } from './gemma-client';
import { callOllamaJsonWithKey, routeOllama } from './ollama';
import { classify, isCodingDestination, withKbFallback } from './rules';
import type { CodingDestination } from './rules';
import { RouterHttpError, RouterMissingKeyError, RouterTimeoutError } from './timeout';
import { getRouterSettings, RouterSettings, setRouterSettings } from './settings';

export type RouterKbContext = {
  readonly extensionUri: { readonly fsPath: string };
  readonly globalStorageUri: { readonly fsPath: string };
};

const cache = new Map<string, RouterResult>();
const CACHE_LIMIT = 100;
let keyStore: SecretStorage | undefined;
let kbContext: RouterKbContext | undefined;
let generation = 0;

export function initializeRouter(secrets: SecretStorage, kb?: RouterKbContext): Disposable {
  keyStore = secrets;
  kbContext = kb;
  cache.clear();
  generation++;
  return secrets.onDidChange(({ key }) => {
    if (key === 'GEMINI_API_KEY' || key === 'BATON_PERSONAL_GEMINI_API_KEY'
      || key === 'OLLAMA_API_KEY' || key === 'BATON_PERSONAL_OLLAMA_API_KEY') {
      cache.clear();
      generation++;
    }
  });
}

export function configureRouter(settings: RouterSettings): void {
  setRouterSettings(settings);
  cache.clear();
  generation++;
}

function describeCallError(error: unknown): string {
  return error instanceof RouterTimeoutError ? 'timed out'
    : error instanceof RouterHttpError ? `HTTP ${error.status}`
    : error instanceof RouterMissingKeyError ? 'API key missing'
    : error instanceof SyntaxError ? 'invalid JSON'
    : 'connection failed';
}

/** Generic JSON call for non-routing work, using the selected provider first. */
export async function callJson<T>(
  systemPrompt: string,
  userPrompt: string,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  const secrets = keyStore;
  if (!secrets) throw new Error('Baton router is not initialized.');
  const failures: string[] = [];

  const primary = getRouterSettings().primary;
  const providers = primary === 'gemma'
    ? (['gemma', 'ollama'] as const) : (['ollama', 'gemma'] as const);
  for (const provider of providers) {
    try {
      const apiKey = await preferredKey(secrets, provider);
      if (!apiKey) throw new RouterMissingKeyError();
      const value = provider === 'gemma'
        ? await callGemmaJsonWithKey(apiKey, systemPrompt, userPrompt)
        : await callOllamaJsonWithKey(apiKey, systemPrompt, userPrompt);
      const parsed = schema.safeParse(value);
      if (parsed.success) return parsed.data;
      failures.push(`${provider}: invalid JSON`);
    } catch (error) {
      failures.push(`${provider}: ${describeCallError(error)}`);
    }
  }

  throw new Error(`Baton could not get valid JSON (${failures.join('; ')}).`);
}

const ModelChoiceSchema = z.object({
  agent_id: z.string().min(1),
  model: z.string().min(1).nullable(),
  reasoning: z.enum(['low', 'medium', 'high', 'default']).nullable(),
  reason: z.string(),
  claim_ids: z.array(z.string()).default([]),
});
type ModelChoice = z.infer<typeof ModelChoiceSchema>;

const MODEL_SYSTEM_PROMPT = `You choose one coding-agent model candidate for a task.

The candidate list in the user message is the ONLY source of truth. Never name an agent or model that is not in the list. Choose exactly one candidate.

Return JSON only:
{
  "agent_id": string,
  "model": string | null,
  "reasoning": "low" | "medium" | "high" | "default" | null,
  "reason": string of at most 200 characters,
  "claim_ids": string[]
}

claim_ids must come from the chosen candidate.
Reasoning guidance: prefer higher reasoning only for high/moderate-risk or multi-file tasks; low for docs and small edits. Use "default" when unsure.`;

const MODEL_CHOICE_FALLBACK = 'KB top candidate (model choice failed validation)';
const NO_MODEL_DATA = 'No model data yet';

function normalizeModelName(value: string | null | undefined): string | null {
  return value ? value.trim().toLowerCase() : null;
}

async function researchForRoute(task: string, route: Route): Promise<{ kb: KnowledgeBase; candidates: Candidate[] } | { error: string } | undefined> {
  if (!kbContext) return undefined;
  try {
    const [kb, availability] = await Promise.all([loadKB(kbContext), loadAvailability(kbContext)]);
    const candidates = await researchAgents({
      task,
      taskType: route.task_type,
      riskTier: route.risk_tier,
      topN: 5,
    }, { kb, availability, globalStorageUri: kbContext.globalStorageUri });
    return { kb, candidates };
  } catch (error) {
    // KB failures never block routing.
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function chooseModel(
  task: string,
  route: Route,
  candidates: Candidate[],
): Promise<{ choice: ModelChoice; candidate: Candidate; destination: CodingDestination } | undefined> {
  try {
    const compact = candidates.map((candidate) => ({
      agent_id: candidate.agent_id,
      model: candidate.model,
      score: candidate.score,
      stale: candidate.stale,
      why: candidate.why.slice(0, 3).map((line) => line.slice(0, 120)),
      claim_ids: candidate.claim_ids,
    }));
    const userPrompt = JSON.stringify({
      task,
      task_type: route.task_type,
      risk_tier: route.risk_tier,
      candidates: compact,
    });
    const choice = await callJson(MODEL_SYSTEM_PROMPT, userPrompt, ModelChoiceSchema);
    const chosen = candidates.find((candidate) => candidate.agent_id === choice.agent_id
      && normalizeModelName(candidate.model) === normalizeModelName(choice.model));
    if (!chosen || !isCodingDestination(choice.agent_id)) return undefined;
    const knownClaims = new Set(chosen.claim_ids);
    if (choice.claim_ids.some((id) => !knownClaims.has(id))) return undefined;
    if (choice.reasoning && choice.reasoning !== 'default'
      && !chosen.reasoning_levels.includes(choice.reasoning)) return undefined;
    return { choice, candidate: chosen, destination: choice.agent_id };
  } catch {
    return undefined;
  }
}

export async function routeTask(task: string, ctxSnippet: string, workspaceUri = ''): Promise<RouterResult> {
  // A changed sharing selection must not reuse a route based on excluded context.
  const cacheKey = createHash('sha256').update(JSON.stringify([task, ctxSnippet, workspaceUri])).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, route: { ...cached.route } };
  const startedGeneration = generation;
  let baseRoute: Route | undefined;
  let tier: 'gemma' | 'ollama' | 'rules' = 'rules';
  let notice: string | undefined;
  const failures: string[] = [];

  if (keyStore && task.trim()) {
    const providers = getRouterSettings().primary === 'gemma'
      ? ([['gemma', routeGemma], ['ollama', routeOllama]] as const)
      : ([['ollama', routeOllama], ['gemma', routeGemma]] as const);
    for (const [providerTier, provider] of providers) {
      try {
        const value = await provider(keyStore, task, ctxSnippet);
        const parsed = RouteSchema.safeParse(value);
        if (parsed.success) {
          baseRoute = parsed.data;
          tier = providerTier;
          break;
        }
        failures.push(`${providerTier}: ${value === undefined ? 'empty response' : 'invalid route response'}`);
      } catch (error) {
        failures.push(`${providerTier}: ${describeCallError(error)}`);
      }
    }
  }

  if (!baseRoute) {
    baseRoute = classify(task);
    tier = 'rules';
    notice = `Using local rules (${failures.join('; ') || 'router unavailable'}).`;
  } else if (failures.length) {
    const fallback = tier === 'ollama' ? 'Ollama' : 'Google AI Studio';
    notice = `${getRouterSettings().primary === 'gemma' ? 'Google AI Studio' : 'Ollama Cloud'} unavailable (${failures[0]}). Routed via ${fallback}.`;
  }

  let route: Route = {
    ...baseRoute,
    recommended_model: null,
    model_reasoning: null,
    kb_refs: [],
    kb_stale: false,
    kb_unverified: false,
    kb_docs_verified: false,
    kb_note: null,
    kb_claims: [],
  };

  // Research runs for every route; only coding destinations consume candidates.
  const researched = task.trim() ? await researchForRoute(task, route) : undefined;
  const snapshot = researched && 'kb' in researched ? researched : undefined;
  if (researched && 'error' in researched) route.kb_note = researched.error;
  let selectedCandidate: Candidate | undefined;
  if (isCodingDestination(route.recommended_destination) && task.trim()) {
    const codingCandidates = snapshot
      ? snapshot.candidates.filter((candidate) => isCodingDestination(candidate.agent_id))
      : [];

    if (snapshot && codingCandidates.length > 0) {
      const top = codingCandidates[0];
      if (snapshot.kb.models.length === 0) {
        selectedCandidate = top;
        route = {
          ...withKbFallback(route, top),
          recommended_model: top.model,
          kb_refs: [...top.claim_ids],
          kb_stale: top.stale,
          kb_note: NO_MODEL_DATA,
        };
      } else if (tier === 'rules') {
        selectedCandidate = top;
        route = {
          ...withKbFallback(route, top),
          recommended_model: top.model,
          kb_refs: [...top.claim_ids],
          kb_stale: top.stale,
        };
      } else {
        const chosen = await chooseModel(task, route, codingCandidates);
        if (chosen) {
          selectedCandidate = chosen.candidate;
          route = {
            ...route,
            recommended_destination: chosen.destination,
            recommended_model: chosen.candidate.model,
            model_reasoning: chosen.choice.reasoning,
            kb_refs: [...chosen.choice.claim_ids],
            kb_stale: chosen.candidate.stale,
            kb_note: chosen.choice.reason,
          };
        } else {
          selectedCandidate = top;
          route = {
            ...withKbFallback(route, top),
            recommended_model: top.model,
            kb_refs: [...top.claim_ids],
            kb_stale: top.stale,
            kb_note: MODEL_CHOICE_FALLBACK,
          };
        }
      }
    }
  }

  if (snapshot && selectedCandidate) {
    const refs = new Set(route.kb_refs ?? []);
    const claims = [
      ...snapshot.kb.agents.flatMap((agent) => [...agent.strengths, ...agent.limits]),
      ...snapshot.kb.models.flatMap((model) => [
        ...model.strengths, ...model.limits,
        ...(model.context_window ? [model.context_window] : []),
        ...(model.cost_note ? [model.cost_note] : []),
      ]),
    ];
    route.kb_unverified = selectedCandidate.unverified;
    route.kb_claims = claims.filter((claim) => refs.has(claim.id))
      .map(({ text, source_url, origin }) => ({ text, source_url, origin }));
    const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const agent = snapshot.kb.agents.find((entry) => entry.id === selectedCandidate.agent_id);
    const model = snapshot.kb.models.find((entry) => entry.agent_id === selectedCandidate.agent_id
      && selectedCandidate.model && key(entry.name) === key(selectedCandidate.model));
    route.kb_docs_verified = [
      ...(agent?.strengths ?? []), ...(agent?.limits ?? []),
      ...(model?.strengths ?? []), ...(model?.limits ?? []),
      ...(model?.context_window ? [model.context_window] : []),
      ...(model?.cost_note ? [model.cost_note] : []),
    ].some((claim) => claim.origin === 'docs');
  }
  if (route.recommended_destination === 'copilot') {
    route.recommended_model = null;
    route.model_reasoning = null;
  }

  const result: RouterResult = { route, tier, notice };
  // A temporary provider failure must not pin this task to the rules tier.
  if (tier !== 'rules' && startedGeneration === generation) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, { ...result, route: { ...route, kb_refs: route.kb_refs ? [...route.kb_refs] : undefined } });
  }
  return result;
}
