'use strict';

// Deterministic, bounded HTTP evidence audit for untrusted discovery output.
// Network work deliberately happens before the reducer/finalization transaction.

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  timeoutMs: 8000,
  attempts: 2,
  maxRedirects: 3,
  maxBodyBytes: 1024 * 1024,
});

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function header(response, name) {
  if (!response || !response.headers) return null;
  if (typeof response.headers.get === 'function') return response.headers.get(name);
  const key = Object.keys(response.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : null;
}

async function readBody(response, maxBytes) {
  if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) {
    const body = Buffer.from(response.body);
    if (body.byteLength > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
    return body.toString('utf8');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* local fixture */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  if (typeof response.text === 'function') {
    const body = await response.text();
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
    return body;
  }
  return '';
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Fetch one URL with bounded retries and redirects. The returned body is kept
// only long enough for fact matching; body_hash/final_url/status are durable.
async function fetchEvidence(url, options = {}) {
  if (!isHttpUrl(url)) return { ok: false, url, final_url: null, status: null, body_hash: null, body: '', error: 'URL must be http(s)' };
  const cfg = { ...DEFAULTS, ...options };
  const fetchImpl = cfg.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');
  const attempts = Math.max(1, Math.min(5, Number(cfg.attempts) || DEFAULTS.attempts));
  const maxRedirects = Math.max(0, Math.min(5, Number(cfg.maxRedirects) || DEFAULTS.maxRedirects));
  const timeoutMs = Math.max(1, Math.min(60000, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs));
  let lastError = 'fetch failed';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let current = url;
    let redirects = 0;
    try {
      while (true) {
        if (!isHttpUrl(current)) throw new Error('redirect target must be http(s)');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        let timeoutTimer;
        try {
          const timeout = new Promise((_, reject) => {
            timeoutTimer = setTimeout(
              () => reject(Object.assign(new Error(`timeout after ${timeoutMs}ms`), { name: 'AbortError' })),
              timeoutMs
            );
          });
          response = await Promise.race([
            Promise.resolve(fetchImpl(current, { redirect: 'manual', signal: controller.signal })),
            timeout,
          ]);
        } finally {
          clearTimeout(timer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
        }
        const status = Number(response && response.status);
        if (status >= 300 && status < 400) {
          const location = header(response, 'location');
          if (!location || redirects >= maxRedirects) {
            return { ok: false, url, final_url: current, status: Number.isFinite(status) ? status : null, body_hash: null, body: '', error: 'redirect limit exceeded or missing Location' };
          }
          current = new URL(location, current).href;
          redirects += 1;
          continue;
        }
        const body = await readBody(response, cfg.maxBodyBytes);
        const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
        const ok = Number.isInteger(status) && status >= 200 && status <= 299;
        if (!ok && attempt + 1 < attempts && (status === 408 || status === 425 || status === 429 || status >= 500)) {
          lastError = `HTTP ${status}`;
          break;
        }
        return { ok, url, final_url: (typeof response.url === 'string' && isHttpUrl(response.url)) ? response.url : current, status: Number.isFinite(status) ? status : null, body_hash: bodyHash, body, error: ok ? null : `HTTP ${status}` };
      }
    } catch (err) {
      lastError = err && err.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (err.message || String(err));
      if (attempt + 1 >= attempts) break;
    }
    await sleep(Math.min(250 * (attempt + 1), 500));
  }
  return { ok: false, url, final_url: null, status: null, body_hash: null, body: '', error: `${lastError} after ${attempts} attempt(s)` };
}

function folded(value) {
  return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function exactInBody(body, value) {
  return typeof value === 'string' && value.trim() !== '' && folded(body).includes(folded(value));
}

function exactModelIdInBody(body, modelId) {
  if (typeof modelId !== 'string' || modelId.trim() === '') return false;
  const text = folded(body);
  const wanted = folded(modelId);
  let offset = 0;
  while (true) {
    const index = text.indexOf(wanted, offset);
    if (index < 0) return false;
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + wanted.length] || '';
    // Model identifiers commonly contain slash, colon, dot, and hyphen. Do
    // not accept a target that is merely a prefix of another identifier.
    if (!/[a-z0-9_@.:\/-]/i.test(before) && !/[a-z0-9_@.:\/-]/i.test(after)) return true;
    offset = index + wanted.length;
  }
}

// Worker text may be HTML. Convert structural HTML boundaries to lines before
// matching so a heading, list item, or table row cannot borrow a removal claim
// from a neighboring item. This intentionally avoids a DOM dependency.
function normalizedEvidenceRegions(body) {
  let text = String(body || '').replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  text = text.replace(/<\s*\/?\s*(?:tr|li|p|div|section|article|h[1-6]|br|hr|dt|dd|table|ul|ol)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, value) => {
      const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : ' ';
    });
  // Keep structural newlines. normalizedEvidenceText intentionally collapses
  // whitespace and is therefore unsuitable for semantic region boundaries.
  text = String(text).normalize('NFKC').toLocaleLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n');
  const regions = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let start = 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      const dotBoundary = ch === '.' && (i + 1 === trimmed.length || /\s/.test(trimmed[i + 1]));
      if (!dotBoundary && !/[!?。！？]/.test(ch)) continue;
      const part = trimmed.slice(start, i + 1).trim();
      if (part) regions.push(part);
      start = i + 1;
    }
    const tail = trimmed.slice(start).trim();
    if (tail) regions.push(tail);
  }
  return regions;
}

// Removal evidence must describe a completed state, not merely a deprecation
// notice. Future and scheduled wording is rejected separately below. Keep the
// bare completed verbs for compact status tables such as "model | removed".
const TERMINATION_LANGUAGE = /(?:\b(?:was|has\s+been|is)\s+(?:removed|discontinued|retired|terminated|decommissioned)\b|\bis\s+no\s+longer\s+(?:available|supported|offered)\b|\b(?:ended|discontinued|retired|removed|terminated|decommissioned)\b|\b(?:shut\s*down|ceased)\b)/i;
const PAID_TRANSITION_LANGUAGE = /(?:\b(?:changed|switched|moved|transitioned)\s+from\s+free\s+to\s+paid\b|\b(?:free(?:\s+(?:api|tier|access))?)\s+(?:is|became|now)\s+paid\b|\b(?:became|is\s+now|now)\s+paid\b)/i;
const FUTURE_TERMINATION_LANGUAGE = /\b(?:will|scheduled|plans?\s+to|planned\s+to|expected\s+to|set\s+to|due\s+to)\b/i;
const CURRENT_LANGUAGE = /\b(?:currently|current|available|supported|live|offered|active)\b/i;
const NEGATED_TERMINATION = /(?:not|never|isn't|isn\'t|wasn\'t|was not|is not)\s*$/i;

const EVIDENCE_DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})?)?\b/gi,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,)?\s+\d{4}\b/gi,
  /\b\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{4}\b/gi,
];

function parseEvidenceDate(raw) {
  const value = String(raw || '').trim();
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) {
    const year = Number(isoDate[1]);
    const month = Number(isoDate[2]);
    const day = Number(isoDate[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  }
  const parsed = Date.parse(value.includes('T') ? value : `${value} UTC`);
  return Number.isFinite(parsed) ? parsed : null;
}

function datesInEvidenceRegion(region) {
  const dates = [];
  for (const pattern of EVIDENCE_DATE_PATTERNS) {
    for (const match of region.matchAll(pattern)) dates.push(match[0]);
  }
  return dates;
}

function removalDateIsCurrent(region, auditTime) {
  const dates = datesInEvidenceRegion(region);
  if (dates.length === 0) return true;
  const audit = parseEvidenceDate(auditTime);
  if (audit === null) return false;
  return dates.every((date) => {
    const parsed = parseEvidenceDate(date);
    return parsed !== null && parsed <= audit;
  });
}

function targetOccurrence(text, modelId) {
  const wanted = folded(modelId);
  let offset = 0;
  while (true) {
    const index = text.indexOf(wanted, offset);
    if (index < 0) return -1;
    const before = index > 0 ? text[index - 1] : '';
    const after = text[index + wanted.length] || '';
    if (!/[a-z0-9_@.:\/-]/i.test(before) && !/[a-z0-9_@.:\/-]/i.test(after)) return index;
    offset = index + wanted.length;
  }
}

function targetIsCurrent(region, modelId) {
  const target = folded(modelId);
  let offset = 0;
  while ((offset = region.indexOf(target, offset)) >= 0) {
    const before = offset > 0 ? region[offset - 1] : '';
    const after = region[offset + target.length] || '';
    if (!/[a-z0-9_@.:\/-]/i.test(before) && !/[a-z0-9_@.:\/-]/i.test(after)) {
      const context = region.slice(Math.max(0, offset - 80), Math.min(region.length, offset + target.length + 100));
      const liveContext = context.replace(/(?:no\s+longer|not|never)\s+(?:available|supported|offered|live)/gi, ' ');
      if (CURRENT_LANGUAGE.test(liveContext)) return true;
    }
    offset += target.length;
  }
  return false;
}

function removalEvidenceRelevant(body, removal, auditTime) {
  if (!removal || typeof removal.model_id !== 'string' || !removal.model_id.trim()) return false;
  return normalizedEvidenceRegions(body).some((region) => {
    const targetIndex = targetOccurrence(region, removal.model_id);
    if (targetIndex < 0 || targetIsCurrent(region, removal.model_id)) return false;
    // A scheduled or future statement is not a completed/current event even
    // when it contains the word "removed". "deprecated" is intentionally not
    // a completion signal and therefore cannot reach this branch by itself.
    if (FUTURE_TERMINATION_LANGUAGE.test(region)) return false;
    if (!removalDateIsCurrent(region, auditTime)) return false;
    const targetEnd = targetIndex + folded(removal.model_id).length;
    const completion = new RegExp(
      `(?:${TERMINATION_LANGUAGE.source}|${PAID_TRANSITION_LANGUAGE.source})`,
      `${TERMINATION_LANGUAGE.flags}g`
    );
    return [...region.matchAll(completion)].some((match) => {
      const prefix = region.slice(Math.max(0, match.index - 24), match.index);
      if (NEGATED_TERMINATION.test(prefix)) return false;
      // A completion phrase must be associated with the target, not with a
      // different model in the same line or table row. The bounded gap keeps
      // prose such as "model-two is available; model-one was removed" false.
      const gap = match.index >= targetEnd ? region.slice(targetEnd, match.index) : region.slice(match.index + match[0].length, targetIndex);
      if (gap.length > 120) return false;
      const otherIds = [...gap.matchAll(/(?:\bmodel[-_][a-z0-9._-]+\b|\b[a-z][a-z0-9]*(?:\/[a-z0-9._:@-]+)+)/gi)]
        .map((item) => item[0]).filter((id) => id !== folded(removal.model_id) && !/^(?:no-longer|well-known)$/i.test(id));
      return otherIds.length === 0;
    });
  });
}

function modelClaims(result, candidate) {
  const models = Array.isArray(result && result.models) ? result.models : [];
  const wanted = candidate && (candidate.model_id || candidate.exact_model_id);
  const matched = wanted ? models.filter((m) => m && m.model_id === wanted) : models;
  return matched.length ? matched : [];
}

function numericEvidenceMatches(body, value) {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const raw = String(value).trim();
  if (!raw) return false;
  return exactInBody(body, raw) || (Number.isFinite(Number(raw)) && exactInBody(body, Number(raw).toFixed(12).replace(/0+$/, '').replace(/\.$/, '')));
}

function normalizedEvidenceText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
}

const PRICE_LABELS = {
  normal_input: /(?<!effective )(?<!discounted )(?<!discount )(?<!promo )(?<!current )(?:normal|list|standard|regular|base|通常|定価|標準)?\s*(?:input|prompt|入力|プロンプト)/i,
  normal_output: /(?<!effective )(?<!discounted )(?<!discount )(?<!promo )(?<!current )(?:normal|list|standard|regular|base|通常|定価|標準)?\s*(?:output|completion|出力|コンプリーション)/i,
  effective_input: /(?:effective|discount(?:ed)?|promo(?:tional)?|current|after discount|実効|割引|キャンペーン|現在)\s*(?:input|prompt|入力|プロンプト)/i,
  effective_output: /(?:effective|discount(?:ed)?|promo(?:tional)?|current|after discount|実効|割引|キャンペーン|現在)\s*(?:output|completion|出力|コンプリーション)/i,
  normal_cache_read: /(?<!effective )(?<!discounted )(?<!discount )(?<!promo )(?<!current )(?:normal|list|standard|regular|base|通常|定価|標準)?\s*(?:cache\s*)?(?:read|読み取り|リード)/i,
  normal_cache_write: /(?<!effective )(?<!discounted )(?<!discount )(?<!promo )(?<!current )(?:normal|list|standard|regular|base|通常|定価|標準)?\s*(?:cache\s*)?(?:write|書き込み|ライト)/i,
  effective_cache_read: /(?:effective|discount(?:ed)?|promo(?:tional)?|current|after discount|実効|割引|キャンペーン|現在)\s*(?:cache\s*)?(?:read|読み取り|リード)/i,
  effective_cache_write: /(?:effective|discount(?:ed)?|promo(?:tional)?|current|after discount|実効|割引|キャンペーン|現在)\s*(?:cache\s*)?(?:write|書き込み|ライト)/i,
};

function valueMatchesLabel(body, value, labelPattern) {
  const text = normalizedEvidenceText(body);
  const wanted = Number(value);
  if (!Number.isFinite(wanted)) return false;
  const numbers = (segment) => [...segment.matchAll(/(?<![A-Za-z])(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?![A-Za-z])/gi)].map((m) => Number(m[0]));
  const labels = [...text.matchAll(new RegExp(labelPattern.source, `${labelPattern.flags}g`))];
  const anyLabel = /(?:input|prompt|output|completion|cache\s*(?:read|write)|入力|プロンプト|出力|読み取り|書き込み)/ig;
  return labels.some((match) => {
    const start = match.index;
    const next = [...text.slice(start + match[0].length).matchAll(anyLabel)][0];
    const end = next ? start + match[0].length + next.index : text.length;
    const after = text.slice(start, Math.min(text.length, end));
    if (numbers(after).some((n) => n === wanted)) return true;
    // Some tables put the amount immediately before its label. Only inspect
    // that short prefix when the label's own region has no amount, otherwise
    // the neighboring output value could satisfy an input claim.
    const before = text.slice(Math.max(0, start - 16), start);
    return numbers(before).some((n) => n === wanted);
  });
}

const RAW_PRICE_FIELDS = {
  normal_input: 'normal_source_amount_input', normal_output: 'normal_source_amount_output',
  normal_cache_read: 'normal_source_amount_cache_read', normal_cache_write: 'normal_source_amount_cache_write',
  effective_input: 'effective_source_amount_input', effective_output: 'effective_source_amount_output',
  effective_cache_read: 'effective_source_amount_cache_read', effective_cache_write: 'effective_source_amount_cache_write',
};

function effectiveInheritedValueMatches(body, value, kind) {
  const text = normalizedEvidenceText(body);
  const marker = kind === 'output' ? /effective\s+(?:input|prompt)/i : /effective\s+cache\s+(?:read|write)/i;
  const target = kind === 'output' ? /(?:output|completion)/i : /cache\s+(?:read|write)/i;
  const match = marker.exec(text);
  if (!match) return false;
  const region = text.slice(match.index, Math.min(text.length, match.index + 80));
  const targetMatch = target.exec(region);
  return !!targetMatch && numericEvidenceMatches(region.slice(targetMatch.index), value);
}

function semanticPriceClaimsRelevant(body, model) {
  const hasNew = Object.values(RAW_PRICE_FIELDS).some((field) => model[field] !== undefined && model[field] !== null);
  const hasLegacy = model.source_amount_input !== undefined || model.source_amount_output !== undefined;
  if (hasNew && hasLegacy) return false;
  if (!hasNew) {
    return valueMatchesLabel(body, model.source_amount_input, /(?:input|prompt|入力|プロンプト)/i) &&
      valueMatchesLabel(body, model.source_amount_output, /(?:output|completion|出力|コンプリーション)/i);
  }
  for (const [kind, field] of Object.entries(RAW_PRICE_FIELDS)) {
    if (model[field] !== undefined && model[field] !== null &&
        !valueMatchesLabel(body, model[field], PRICE_LABELS[kind]) &&
        !(kind === 'effective_output' && effectiveInheritedValueMatches(body, model[field], 'output')) &&
        !(kind === 'effective_cache_read' && effectiveInheritedValueMatches(body, model[field], 'cache_read')) &&
        !(kind === 'effective_cache_write' && effectiveInheritedValueMatches(body, model[field], 'cache_write'))) return false;
  }
  return ['normal_input', 'normal_output', 'effective_input', 'effective_output']
    .every((kind) => model[RAW_PRICE_FIELDS[kind]] !== undefined && model[RAW_PRICE_FIELDS[kind]] !== null);
}

const PRICE_UNIT_ALIASES = {
  per_token: 'per_token',
  'per-token': 'per_token',
  'per token': 'per_token',
  pertoken: 'per_token',
  token: 'per_token',
  per_million_tokens: 'per_million_tokens',
  'per-million-tokens': 'per_million_tokens',
  'per million tokens': 'per_million_tokens',
  'per million': 'per_million_tokens',
  per_million: 'per_million_tokens',
  per_1m_tokens: 'per_million_tokens',
  'per 1m tokens': 'per_million_tokens',
};

function normalizePriceUnit(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, ' ');
  return PRICE_UNIT_ALIASES[key] || PRICE_UNIT_ALIASES[key.replace(/ /g, '-')] || null;
}

// Unit evidence is deliberately semantic rather than a loose token search:
// a per-token claim must not be accepted by text that only says per million
// tokens, and the reverse is equally important for price normalization.
function priceUnitEvidenceRelevant(body, sourceUnit) {
  const unit = normalizePriceUnit(sourceUnit);
  if (!unit) return false;
  const text = String(body || '');
  if (unit === 'per_token') {
    return /\bper[\s_-]+tokens?\b|\/[\s_-]*tokens?\b|\btoken[\s_-]+based\b/i.test(text);
  }
  return /\bper[\s_-]+(?:million|1\s*m|1(?:\s*[, ]\s*)?000(?:\s*[, ]\s*)?000)[\s_-]*tokens?\b|\/[\s_-]*(?:million|1\s*m|1(?:\s*[, ]\s*)?000(?:\s*[, ]\s*)?000)[\s_-]*tokens?\b/i.test(text);
}

function dateEvidenceRelevant(body, value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (exactInBody(body, value)) return true;
  const dateOnly = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
  return !!dateOnly && exactInBody(body, dateOnly[1]);
}

// Discount dates must be bound to their semantic body labels: start,
// effective-from, and begins labels confirm the claimed start date; end,
// until, expires, and valid-through labels confirm the claimed end date.
// Finding both dates anywhere is not confirmation, and dates presented
// under swapped labels fail.
const DISCOUNT_START_LABEL = /(?:starts?|begins?|beginning|effective\s+(?:from|as\s+of)|valid\s+from|from|runs?|launches?\s+on|start(?:ing)?\s+(?:on|at))/i;
const DISCOUNT_END_LABEL = /(?:ends?|until|till|expires?|expiration|valid\s+through|through|deadline)/i;
const ANY_DISCOUNT_LABEL = /(?:starts?|begins?|beginning|effective\s+(?:from|as\s+of)|valid\s+(?:from|through)|from|runs?|launches?\s+on|start(?:ing)?\s+(?:on|at)|ends?|until|till|expires?|expiration|through|deadline)/i;

// Confirms value under one label occurrence. The region after the label is
// bounded by the next discount label, so the opposite boundary's date can
// never confirm a claim meant for this one.
function dateConfirmedByLabel(body, value, labelPattern) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const text = normalizedEvidenceText(body);
  const dateOnly = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
  if (!dateOnly) return false;
  const wanted = dateOnly[1];
  const labels = [...text.matchAll(new RegExp(labelPattern.source, `${labelPattern.flags}g`))];
  return labels.some((match) => {
    const after = match.index + match[0].length;
    const next = [...text.slice(after).matchAll(new RegExp(ANY_DISCOUNT_LABEL.source, `${ANY_DISCOUNT_LABEL.flags}g`))][0];
    const end = next ? after + next.index : Math.min(text.length, after + 80);
    return text.slice(after, end).includes(wanted);
  });
}

// Discounted pricing is any price whose normal and effective raw amounts
// differ, or whose fetched body describes a limited or promotional price.
// This must be decided from the fetched body and raw evidence, never from a
// worker supplied typed USD value.
const DISCOUNT_MARKER = /(?:limited|promo(?:tional)?|discount(?:ed)?|sale|expir(?:y|es|ation)|campaign|期間限定|割引|キャンペーン)/i;
const RAW_DISCOUNT_PAIRS = [
  ['normal_source_amount_input', 'effective_source_amount_input'],
  ['normal_source_amount_output', 'effective_source_amount_output'],
  ['normal_source_amount_cache_read', 'effective_source_amount_cache_read'],
  ['normal_source_amount_cache_write', 'effective_source_amount_cache_write'],
];

function isValidIsoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) return false;
  return !Number.isNaN(Date.parse(value));
}

function hasDiscountedPricing(model, body) {
  if (DISCOUNT_MARKER.test(String(body || ''))) return true;
  return RAW_DISCOUNT_PAIRS.some(([normalKey, effectiveKey]) => {
    const normal = model && model[normalKey];
    const effective = model && model[effectiveKey];
    if (normal === undefined && effective === undefined) return false;
    if (normal === null && effective === null) return false;
    if (normal === undefined || effective === undefined || normal === null || effective === null) return true;
    return Number(normal) !== Number(effective);
  });
}

function validDiscountDates(body, model, auditTime) {
  const start = model && model.discount_start_at;
  const end = model && model.discount_end_at;
  if (!isValidIsoTime(start) || !isValidIsoTime(end)) return false;
  if (Date.parse(start) >= Date.parse(end)) return false;
  // Fresh only while the deterministic audit/fetch time is inside the
  // published interval: start inclusive, end exclusive.
  if (typeof auditTime !== 'string' || !isValidIsoTime(auditTime)) return false;
  const t = Date.parse(auditTime);
  if (Date.parse(start) > t || t >= Date.parse(end)) return false;
  return dateConfirmedByLabel(body, start, DISCOUNT_START_LABEL) &&
    dateConfirmedByLabel(body, end, DISCOUNT_END_LABEL);
}

function priceEvidenceRelevant(body, model) {
  if (!model || !exactInBody(body, model.model_id)) return false;
  if (!priceUnitEvidenceRelevant(body, model.source_unit)) return false;
  if (!semanticPriceClaimsRelevant(body, model)) return false;
  const currency = String(model.source_currency || 'USD').trim().toUpperCase();
  if (currency === 'USD') return /\bUSD\b|\$|US dollars?/i.test(body);
  return new RegExp(`\\b${currency}\\b`, 'i').test(normalizedEvidenceText(body));
}

function conversionEvidenceRelevant(body, model) {
  if (!model || typeof model.conversion_rate !== 'number' || model.conversion_rate <= 0) return false;
  const currency = String(model.source_currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency) || currency === 'USD') return false;
  if (!dateEvidenceRelevant(body, model.conversion_confirmed_at)) return false;
  const rate = Number(model.conversion_rate);
  const rateText = rate.toString();
  const escaped = currency;
  const ratePattern = `(?:${rateText}|${rate.toFixed(12).replace(/0+$/, '').replace(/\\.$/, '')})`;
  // Direction is explicit: one source currency unit buys rate USD. The
  // reverse relation (one USD buys source currency) never matches.
  const forward = new RegExp(`(?:1\\s*${escaped}\\s*(?:=|equals|is)\\s*${ratePattern}\\s*USD|${escaped}\\s*1\\s*(?:=|equals|is)\\s*USD\\s*${ratePattern})`, 'i');
  return forward.test(normalizedEvidenceText(body));
}

const STRUCTURED_PRICE_FIELDS = [
  'source_amount_input', 'source_amount_output',
  'normal_source_amount_input', 'normal_source_amount_output',
  'normal_source_amount_cache_read', 'normal_source_amount_cache_write',
  'effective_source_amount_input', 'effective_source_amount_output',
  'effective_source_amount_cache_read', 'effective_source_amount_cache_write',
  'source_currency', 'source_unit', 'conversion_rate', 'conversion_source', 'conversion_confirmed_at',
  'price_source_url', 'discount_start_at', 'discount_end_at',
];

async function auditModelPriceEvidence(model, getFetch, auditTime) {
  if (!model || typeof model !== 'object') return model;
  // Typed USD claims are never worker authority. An unrecognized or legacy
  // typed key is itself an unverified optional pricing claim, so reject the
  // complete fresh update rather than preserving a partial interpretation.
  if (Object.keys(model).some((key) => /(?:^|_)price_usd$/.test(key))) return stripStructuredPriceClaims(model);
  const priceUrl = model.price_source_url;
  const currency = String(model.source_currency || 'USD').trim().toUpperCase();
  if (!isHttpUrl(priceUrl)) return stripStructuredPriceClaims(model);
  const priceFetch = await getFetch(priceUrl);
  if (!priceFetch.ok || !priceEvidenceRelevant(priceFetch.body, model)) {
    return stripStructuredPriceClaims(model);
  }
  if (currency !== 'USD') {
    const conversionUrl = model.conversion_source;
    if (!isHttpUrl(conversionUrl) || conversionUrl === priceUrl) return stripStructuredPriceClaims(model);
    const conversionFetch = await getFetch(conversionUrl);
    if (!conversionFetch.ok || !conversionEvidenceRelevant(conversionFetch.body, model)) {
      return stripStructuredPriceClaims(model);
    }
  }
  // Any discount marker, including a raw normal/effective mismatch, requires
  // both valid ISO dates in the fetched 2xx price body, ordered start before
  // end, with the deterministic audit time inside [start, end), and each date
  // confirmed under its semantic label. A missing, malformed, reversed,
  // swapped-label, expired, future, or unconfirmed date rejects the complete
  // fresh pricing update; the reducer then retains the prior typed prices
  // and confirmation date.
  const hasAnyDiscountDate = model.discount_start_at !== undefined || model.discount_end_at !== undefined;
  if (hasDiscountedPricing(model, priceFetch.body) || hasAnyDiscountDate) {
    if (!validDiscountDates(priceFetch.body, model, auditTime)) return stripStructuredPriceClaims(model);
  }
  return { ...model, _price_evidence_verified: true };
}

function stripStructuredPriceClaims(model) {
  const out = { ...model };
  for (const field of STRUCTURED_PRICE_FIELDS) delete out[field];
  delete out._price_evidence_verified;
  return out;
}

function factMatches(body, model, candidate) {
  const c = candidate || {};
  const facts = [c.fact, c.fact_text, c.pricing_text, c.price_text, c.benchmark_name, c.benchmark_version]
    .filter((v) => typeof v === 'string' && v.trim());
  if (typeof c.benchmark_score === 'number') facts.push(String(c.benchmark_score));
  if (typeof c.score === 'number') facts.push(String(c.score));
  if (model) {
    facts.push(model.pricing_text, model.free_quota_text, model.params_text);
    for (const find of model.benchmark_finds || []) {
      facts.push(find && find.name);
      if (find && typeof find.score === 'number') facts.push(String(find.score));
    }
    for (const value of [model.source_amount_input, model.source_amount_output]) {
      if (typeof value === 'number') facts.push(String(value));
    }
  }
  return facts.some((fact) => exactInBody(body, fact));
}

function sourceRelevant(result, candidate, body) {
  const models = modelClaims(result, candidate);
  if (models.length === 0) return { ok: false, reason: 'source candidate has no exact model fact in its artifact' };
  const model = models[0];
  if (!exactInBody(body, model.model_id)) return { ok: false, reason: 'fetched source body does not contain the exact model id' };
  const provider = candidate.provider_key || model.provider_key || result.provider_key;
  const providerLabel = candidate.provider_label || model.provider_label || model.provider_name;
  if (provider && provider !== '_discovery' && !exactInBody(body, provider) &&
      !(providerLabel && exactInBody(body, providerLabel))) {
    return { ok: false, reason: 'fetched source body does not contain the exact provider fact' };
  }
  if (!factMatches(body, model, candidate)) return { ok: false, reason: 'fetched source body has no relevant price or benchmark fact from the artifact' };
  return { ok: true, model };
}

function providerRelevant(candidate, body) {
  if (!exactInBody(body, candidate.base_url)) return 'fetched docs do not contain the exact base_url';
  if (!exactInBody(body, candidate.model_id_example)) return 'fetched docs do not contain the exact model_id_example';
  let pattern;
  try { pattern = new RegExp(candidate.model_id_pattern); } catch { return 'model_id_pattern is not a valid regex'; }
  if (!pattern.test(candidate.model_id_example)) return 'model_id_pattern does not match model_id_example';
  return null;
}

function sourceKey(candidate) {
  const label = String(candidate.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${candidate.category}:${label}`;
}

function loadRegistryProviders(options = {}) {
  if (Array.isArray(options.registryProviders)) return options.registryProviders;
  const registryPath = options.registryPath || require('node:path').resolve(__dirname, '../../build/provider-registry.json');
  try {
    const raw = JSON.parse(require('node:fs').readFileSync(registryPath, 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw.providers) ? raw.providers : []);
  } catch {
    return [];
  }
}

// User content can live on the provider's own origin, so origin equality is
// not sufficient for removal evidence. These hosts require the fetched URL to
// stay at the exact Registry URL or below its deterministic Registry path.
const MULTI_TENANT_HOSTS = new Set([
  'huggingface.co', 'github.com', 'gitlab.com', 'medium.com',
  'x.com', 'twitter.com', 'raw.githubusercontent.com', 'gist.github.com',
  'reddit.com', 'www.reddit.com', 'dev.to', 'substack.com', 'notion.site',
]);

function pathPrefix(pathname) {
  const normalized = String(pathname || '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '/';
}

function canonicalEvidenceOrigins(task, result, registryProviders) {
  const providerKey = result && result.provider_key || task && task.provider_key;
  const registry = (registryProviders || []).find((provider) => provider && provider.key === providerKey) || {};
  const urls = [
    registry.endpoint_source, registry.api_catalog_url, registry.docs_url, registry.base_url,
    task && task.endpoint_source, task && task.api_catalog_url, task && task.docs_url, task && task.base_url,
  ];
  const origins = new Set();
  const prefixes = [];
  for (const value of urls) {
    if (!isHttpUrl(value)) continue;
    try {
      const parsed = new URL(value);
      const origin = parsed.origin.toLowerCase();
      origins.add(origin);
      if (MULTI_TENANT_HOSTS.has(parsed.hostname.toLowerCase())) {
        prefixes.push({ origin, path: pathPrefix(parsed.pathname) });
      }
    } catch { /* invalid URL is not an allowlist entry */ }
  }
  return { origins, prefixes };
}

function urlWithinPrefix(value, prefix) {
  if (!isHttpUrl(value) || !prefix) return false;
  try {
    const parsed = new URL(value);
    if (parsed.origin.toLowerCase() !== prefix.origin) return false;
    const path = pathPrefix(parsed.pathname);
    return prefix.path === '/' || path === prefix.path || path.startsWith(`${prefix.path}/`);
  } catch {
    return false;
  }
}

function provenanceAllowed(url, finalUrl, allowlist) {
  if (!isHttpUrl(url) || !isHttpUrl(finalUrl)) return false;
  // Keep compatibility for callers that pass the former origin Set, while
  // production audits use the path aware allowlist returned above.
  if (allowlist instanceof Set) {
    try {
      return allowlist.has(new URL(url).origin.toLowerCase()) && allowlist.has(new URL(finalUrl).origin.toLowerCase());
    } catch {
      return false;
    }
  }
  if (!allowlist || !(allowlist.origins instanceof Set) || allowlist.origins.size === 0) return false;
  try {
    const source = new URL(url);
    const final = new URL(finalUrl);
    const sourceOrigin = source.origin.toLowerCase();
    const finalOrigin = final.origin.toLowerCase();
    if (!allowlist.origins.has(sourceOrigin) || !allowlist.origins.has(finalOrigin)) return false;
    const isAllowedUrl = (value) => {
      const parsed = new URL(value);
      const strictPrefixes = (allowlist.prefixes || []).filter((prefix) => prefix.origin === parsed.origin.toLowerCase());
      if (strictPrefixes.length === 0) return true;
      // A multi tenant origin is accepted only through one of its Registry
      // namespace prefixes.
      return strictPrefixes.some((prefix) => urlWithinPrefix(value, prefix));
    };
    // Check both the requested URL and the final redirect URL. A redirect to
    // a user content path must not become acceptable merely because its
    // starting URL was on a non multi tenant origin.
    return isAllowedUrl(url) && isAllowedUrl(finalUrl);
  } catch {
    return false;
  }
}

// Audit every worker candidate once per stable URL and return task-local,
// reducer-ready evidence. SQLite is touched only by the caller after this
// function has finished all network I/O.
async function auditRunEvidence(tasks, options = {}) {
  const fetchCache = new Map();
  const registryProviders = loadRegistryProviders(options);
  const sourceHealth = new Map();
  const sourceCache = [];
  const auditedTasks = [];
  const getFetch = async (url) => {
    if (!fetchCache.has(url)) fetchCache.set(url, fetchEvidence(url, options));
    return fetchCache.get(url);
  };
  const markSource = (source, verified, attemptedAt, successAt = null) => {
    const key = source.source_key || sourceKey(source);
    const prior = sourceHealth.get(key) || { source_key: key, source_url: source.source_url || null, verified: false, attempted_at: attemptedAt, success_at: null };
    prior.attempted_at = attemptedAt;
    if (verified) {
      prior.verified = true;
      prior.success_at = successAt || prior.success_at || attemptedAt;
    }
    sourceHealth.set(key, prior);
  };

  for (const task of tasks || []) {
    const result = task.result_json;
    if (!result || typeof result !== 'object') { auditedTasks.push(task); continue; }
    const out = { ...result };
    const now = options.now || new Date().toISOString();
    const evidence = [];
    const rawModels = Array.isArray(result.models) ? result.models : [];
    out.models = [];
    for (const model of rawModels) {
      out.models.push(await auditModelPriceEvidence(model, getFetch, now));
    }
    const removals = [];
    const rawRemovals = Array.isArray(result.removals) ? result.removals : [];
    const removalOrigins = canonicalEvidenceOrigins(task, result, registryProviders);
    for (const removal of rawRemovals) {
      if (!removal || typeof removal !== 'object' ||
          typeof removal.model_id !== 'string' || !removal.model_id.trim() ||
          typeof removal.reason !== 'string' || !removal.reason.trim() ||
          !isHttpUrl(removal.source_url)) continue;
      const fetched = await getFetch(removal.source_url);
      // Explicit removal is the most dangerous worker claim. Require both
      // semantic binding and an allowed assigned provider origin. A redirect
      // is accepted only when its final URL remains on that origin.
      if (!fetched.ok || !provenanceAllowed(removal.source_url, fetched.final_url, removalOrigins) ||
          !removalEvidenceRelevant(fetched.body, removal, now)) continue;
      removals.push({
        ...removal,
        _evidence_verified: true,
        _evidence: {
          url: removal.source_url,
          final_url: fetched.final_url,
          status: fetched.status,
          body_hash: fetched.body_hash,
        },
      });
      const subjectKey = `removal:${removal.model_id}`;
      sourceCache.push({
        url: removal.source_url,
        subject_key: subjectKey,
        provider_key: result.provider_key || null,
        exact_model_id: removal.model_id,
        fetched_at: now,
        http_status: fetched.status,
        content_hash: fetched.body_hash,
      });
      evidence.push({
        url: removal.source_url,
        final_url: fetched.final_url,
        status: fetched.status,
        body_hash: fetched.body_hash,
        subject_key: subjectKey,
      });
    }
    out.removals = removals;
    const auditedRemovalIds = new Set(removals.map((removal) => removal.model_id));
    out.models = out.models.map((model) => {
      if (!model || model.offer_ended !== true || auditedRemovalIds.has(model.model_id)) return model;
      const { offer_ended: _offerEnded, ...withoutUnverifiedRemoval } = model;
      return withoutUnverifiedRemoval;
    });
    const sources = [];
    const providers = [];
    const sourceCandidates = Array.isArray(result.source_candidates) ? result.source_candidates : [];
    const seenSources = new Set();
    for (const candidate of sourceCandidates) {
      const key = sourceKey(candidate || {});
      if (seenSources.has(key)) continue;
      seenSources.add(key);
      if (!isHttpUrl(candidate && candidate.source_url)) continue;
      const fetched = await getFetch(candidate.source_url);
      const relevance = fetched.ok ? sourceRelevant(result, candidate, fetched.body) : { ok: false, reason: fetched.error };
      markSource({ ...candidate, source_key: key }, relevance.ok, now, relevance.ok ? now : null);
      if (!relevance.ok) continue;
      sources.push({ ...candidate, _evidence_verified: true, _evidence: { url: candidate.source_url, final_url: fetched.final_url, status: fetched.status, body_hash: fetched.body_hash } });
      sourceCache.push({ url: candidate.source_url, subject_key: `discovery:${key}`, provider_key: candidate.provider_key || result.provider_key || null, exact_model_id: relevance.model.model_id, fetched_at: now, http_status: fetched.status, content_hash: fetched.body_hash });
      evidence.push({ url: candidate.source_url, final_url: fetched.final_url, status: fetched.status, body_hash: fetched.body_hash, subject_key: `discovery:${key}` });
    }
    const providerCandidates = Array.isArray(result.provider_candidates) ? result.provider_candidates : [];
    const seenProviders = new Set();
    for (const candidate of providerCandidates) {
      const key = candidate && candidate.provider_key;
      if (seenProviders.has(key)) continue;
      seenProviders.add(key);
      if (!candidate || !isHttpUrl(candidate.docs_url)) continue;
      const fetched = await getFetch(candidate.docs_url);
      const reason = fetched.ok ? providerRelevant(candidate, fetched.body) : fetched.error;
      if (reason) continue;
      const entry = { ...candidate, _evidence_verified: true, _evidence: { url: candidate.docs_url, final_url: fetched.final_url, status: fetched.status, body_hash: fetched.body_hash } };
      providers.push(entry);
      sourceCache.push({ url: candidate.docs_url, subject_key: `provider:${key}`, provider_key: key, exact_model_id: candidate.model_id_example, fetched_at: now, http_status: fetched.status, content_hash: fetched.body_hash });
      evidence.push({ url: candidate.docs_url, final_url: fetched.final_url, status: fetched.status, body_hash: fetched.body_hash, subject_key: `provider:${key}` });
    }
    // The audit result is internal reducer data; worker schema remains the
    // contract for the original artifact, while rejected/duplicate claims
    // never reach staging.
    out.source_candidates = sources;
    out.provider_candidates = providers;
    out._evidence = { source_health: [...sourceHealth.values()], source_cache: sourceCache.filter((e) => e.subject_key.startsWith('discovery:') || e.subject_key.startsWith('provider:') || e.subject_key.startsWith('removal:')), fetches: evidence };
    auditedTasks.push({ ...task, result_json: out });
  }

  // Sources assigned by SQLite must be attempted even when the worker omitted
  // them. Null URLs are recorded as failed attempts without a fetch.
  const discoveryTask = (tasks || []).find((t) => t.kind === 'discovery');
  const assignment = discoveryTask && discoveryTask.assigned_json && !Array.isArray(discoveryTask.assigned_json)
    ? discoveryTask.assigned_json : {};
  const attemptedAt = options.now || new Date().toISOString();
  for (const source of assignment.discovery_sources || []) {
    const key = source.source_key || sourceKey(source);
    const fetched = source.source_url ? await getFetch(source.source_url) : null;
    const relevant = fetched && fetched.ok && [...sourceHealth.values()].some((h) => h.source_key === key && h.verified);
    markSource({ ...source, source_key: key }, !!relevant, attemptedAt, relevant ? attemptedAt : null);
  }
  for (const term of assignment.search_terms || []) {
    // Terms are tracked atomically by finalizeRun; this list is intentionally
    // separate from source health because a search can have no URL result.
    term._attempted_at = attemptedAt;
  }
  return { tasks: auditedTasks, sourceCache, sourceHealth: [...sourceHealth.values()], terms: assignment.search_terms || [] };
}

module.exports = {
  fetchEvidence,
  fetchOfficialEvidence: fetchEvidence,
  auditRunEvidence,
  sourceRelevant,
  providerRelevant,
  removalEvidenceRelevant,
  normalizedEvidenceRegions,
  provenanceAllowed,
  priceEvidenceRelevant,
  conversionEvidenceRelevant,
  isHttpUrl,
};
