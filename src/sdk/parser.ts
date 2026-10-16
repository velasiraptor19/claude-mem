
import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';

// TODO(#2233): migrate to Anthropic tool-use API for deterministic JSON output. This text-XML path is the bridge.
// Only strip fences when the entire payload is a single fenced block. Stripping
// the first opening + last closing fence anywhere in the string can corrupt
// content that contains internal fenced examples or surrounding prose
// (CodeRabbit review on PR #2282).
function stripCodeFences(text: string): string {
  const match = text.match(/^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  skipped?: boolean;
  skip_reason?: string | null;
}

const OBSERVATION_TITLE_MAX_GRAPHEMES = 120;
const OBSERVATION_TITLE_TRUNCATE_AT = 117;
const observationGraphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export type ParseResult =
  | {
      valid: true;
      observations: ParsedObservation[];
      summary: ParsedSummary | null;
      /**
       * Tags outside the observation schema found in blocks whose own fields
       * were missing and whose content was salvaged — the model drifting off
       * the schema (`<kind>`/`<detail>` for `<type>`/`<title>`, #3461). Sorted,
       * lowercase; absent when there was no drift.
       */
      schemaDrift?: string[];
    }
  | { valid: false };

/** Every tag the observation schema defines, wrappers and elements alike. */
const OBSERVATION_SCHEMA_TAGS = new Set([
  'type', 'title', 'subtitle', 'narrative', 'facts', 'fact', 'concepts', 'concept',
  'files_read', 'files_modified', 'file',
]);
/**
 * NVIDIA occasionally mirrors the formatting of the type legend instead of
 * emitting the bare enum value, e.g. `[change]` or `[**type**: discovery]`.
 * Keep the vocabulary closed: an observation type is used by filters,
 * telemetry and context compilation, so accepting prose here pollutes all
 * three. Unknown values intentionally fall back to the active mode's first
 * type; the original malformed value remains in the parser log for diagnosis.
 */
function normalizeObservationType(rawType: string, validTypes: string[]): string | null {
  const trimmed = rawType.trim();
  const direct = validTypes.find(type => type.toLowerCase() === trimmed.toLowerCase());
  if (direct) return direct;

  const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canonical = validTypes.map(escapeRegex).join('|');
  // Accept a canonical enum only when it appears in the conventional leading
  // type position. Do not infer from arbitrary prose such as a title.
  const wrapped = new RegExp(
    `^[\\s\\[*_]*?(?:\\*{1,2}\\s*)?(?:(?:\\*{0,2}type\\*{0,2})\\s*:\\s*)?(${canonical})\\b`,
    'i'
  ).exec(trimmed);
  if (wrapped) {
    return validTypes.find(type => type.toLowerCase() === wrapped[1].toLowerCase()) ?? null;
  }

  // These are stable short aliases emitted by the NVIDIA model. They denote
  // the same intent as the canonical code-mode categories.
  const aliases: Record<string, string> = {
    error: 'discovery',
    patch: 'change',
    pattern: 'discovery',
  };
  const alias = aliases[trimmed.toLowerCase()];
  return alias && validTypes.includes(alias) ? alias : null;
}

// NVIDIA can leak its Markdown field labels into <title>, e.g.
// `[**title**: Worker healthy]` or `[**Discovery**]: inspected parser`.
// This is presentation-only syntax, never part of the observation title.
function normalizeObservationTitle(rawTitle: string): string | null {
  const trimmed = rawTitle.trim();
  const titleMatch = /^\[\*\*title\*\*:\s*/i.exec(trimmed);
  if (titleMatch) {
    const content = trimmed.slice(titleMatch[0].length).trim();
    const normalized = content.endsWith(']') ? content.slice(0, -1).trim() : content;
    // A bare Markdown label carries no semantic title. Preserve the absence
    // instead of introducing a synthetic UI label into persistent memory.
    return normalized || null;
  }

  const typedMatch = /^\[\*\*(?:bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive)\*\*(?:\]\s*:?\s*|:\s*)/i.exec(trimmed);
  if (!typedMatch) return trimmed;
  const content = trimmed.slice(typedMatch[0].length).trim();
  const normalized = typedMatch[0].includes(':') && content.endsWith(']') ? content.slice(0, -1).trim() : content;
  return normalized || null;
}

// NVIDIA can also echo the XML field name as Markdown inside the corresponding
// value, e.g. `<subtitle>[**subtitle**: concise detail]</subtitle>`.  Only
// remove the matching field label: arbitrary Markdown labels such as
// `[**timed_out**]` carry user-visible meaning and must remain untouched.
function normalizeObservationFieldLabel(rawValue: string, field: 'subtitle' | 'narrative'): string | null {
  const trimmed = rawValue.trim();
  const fieldMatch = new RegExp(`^\\[\\*\\*${field}\\*\\*:\\s*`, 'i').exec(trimmed);
  if (!fieldMatch) return trimmed;
  const content = trimmed.slice(fieldMatch[0].length).trim();
  const normalized = content.endsWith(']') ? content.slice(0, -1).trim() : content;
  return normalized || null;
}

export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false };
  }

  raw = stripCodeFences(raw);

  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/i.exec(raw);
  if (skipMatch) {
    return {
      valid: true,
      observations: [],
      summary: {
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        skipped: true,
        skip_reason: skipMatch[1] === undefined ? null : decodeXmlReferences(skipMatch[1]),
      },
    };
  }

  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    return { valid: false };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const schemaDrift = new Set<string>();
    const observations = parseObservationBlocks(raw, correlationId, schemaDrift);
    if (observations.length === 0) {
      return { valid: false };
    }
    return {
      valid: true,
      observations,
      summary: null,
      ...(schemaDrift.size > 0 ? { schemaDrift: [...schemaDrift].sort() } : {}),
    };
  }

  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return { valid: false };
  }
  return { valid: true, observations: [], summary };
}

function parseObservationBlocks(
  text: string,
  correlationId?: string | number,
  schemaDrift?: Set<string>,
): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  const observationRegex = /<observation>([\s\S]*?)<\/observation>/gi;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const rawTitle = extractField(obsContent, 'title');
    const title = rawTitle ? normalizeObservationTitle(unwrapLabelWrappedTitle(rawTitle) ?? '') : null;
    if (rawTitle && title !== rawTitle) {
      logger.warn('PARSER', `Normalized observation title wrapper: ${rawTitle.slice(0, 80)}`, { correlationId });
    }
    const rawSubtitle = extractField(obsContent, 'subtitle');
    const subtitle = rawSubtitle ? normalizeObservationFieldLabel(rawSubtitle, 'subtitle') : null;
    if (rawSubtitle && subtitle !== rawSubtitle) {
      logger.warn('PARSER', `Normalized observation subtitle wrapper: ${rawSubtitle.slice(0, 80)}`, { correlationId });
    }
    const rawNarrative = extractField(obsContent, 'narrative');
    const narrative = rawNarrative ? normalizeObservationFieldLabel(rawNarrative, 'narrative') : null;
    if (rawNarrative && narrative !== rawNarrative) {
      logger.warn('PARSER', `Normalized observation narrative wrapper: ${rawNarrative.slice(0, 80)}`, { correlationId });
    }
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    const fallbackType = validTypes[0];
    let finalType = fallbackType;
    if (type) {
      const normalizedType = normalizeObservationType(type, validTypes);
      if (normalizedType) {
        finalType = normalizedType;
        if (normalizedType !== type) {
          logger.warn('PARSER', `Normalized observation type: ${type} -> ${normalizedType}`, { correlationId });
        }
      } else {
        logger.warn('PARSER', `Invalid observation type: ${type}, using "${fallbackType}"`, { correlationId });
      }
    } else {
      logger.error('PARSER', `Observation missing type field, defaulting to the first declared type: "${fallbackType}"`, { correlationId });
    }

    // #3379: concepts are matched exactly by the injection SQL, so a prefixed
    // tag like "gotcha: WASM quirk" would never match. Truncate at the first
    // ':' and trim, then drop empties and the observation type.
    const cleanedConcepts = concepts
      .map(c => {
        const colonIndex = c.indexOf(':');
        return (colonIndex === -1 ? c : c.slice(0, colonIndex)).trim();
      })
      .filter(c => c !== '' && c !== finalType);
    let finalTitle = title;
    let finalNarrative = narrative;

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      const salvageNarrative = extractUnstructuredObservationText(obsContent);
      if (!salvageNarrative) {
        logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
          correlationId,
          type: finalType
        });
        continue;
      }

      const salvage = extractObservationFallback(salvageNarrative);
      finalTitle = salvage.title;
      finalNarrative = salvage.narrative;
      for (const tag of obsContent.matchAll(/<\/?([A-Za-z_][\w-]*)\b[^>]*>/g)) {
        const name = tag[1].toLowerCase();
        if (!OBSERVATION_SCHEMA_TAGS.has(name)) schemaDrift?.add(name);
      }
      logger.warn('PARSER', 'Salvaged unstructured observation prose as narrative', {
        correlationId,
        type: finalType,
        chars: salvageNarrative.length
      });
    }

    observations.push({
      type: finalType,
      title: finalTitle,
      subtitle,
      facts,
      narrative: finalNarrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

function parseSummaryBlock(text: string, correlationId?: string | number): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/i;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];

  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); 

  if (!request && !investigated && !learned && !completed && !next_steps && !notes) {
    logger.warn('PARSER', 'Summary block has no sub-tags — rejecting false positive', { correlationId });
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes,
  };
}

// Some local observers echo the field label into the value, producing
// `<title>[**title**: Example observation]</title>`. Only this complete,
// unambiguous wrapper is unwrapped; partial forms and legitimately bracketed
// titles are stored as-is (#3907).
const LABEL_WRAPPED_TITLE = /^\[\*\*title\*\*:\s*([\s\S]+?)\s*\]$/;

function unwrapLabelWrappedTitle(title: string | null): string | null {
  if (title === null) return null;
  const match = LABEL_WRAPPED_TITLE.exec(title);
  if (!match) return title;
  const inner = match[1].trim();
  return inner === '' ? title : inner;
}

// Decode only after extracting markup: an escaped tag is character data, not
// another element. A single replacement pass keeps &amp;lt; as literal &lt;.
const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXmlReferences(value: string): string {
  return value.replace(/<!\[CDATA\[[\s\S]*?\]\]>|&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-fA-F]+|[0-9]+));/g, reference => {
    if (reference.startsWith('<![CDATA[')) return reference;
    const name = reference.slice(1, -1);
    if (!name.startsWith('#')) return XML_ENTITIES[name];
    const codePoint = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    // Only XML 1.0 legal characters are references; retain existing literal
    // behavior for malformed/undeclared references in this text-XML bridge.
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 ||
        (codePoint >= 0x20 && codePoint <= 0xD7FF) ||
        (codePoint >= 0xE000 && codePoint <= 0xFFFD) ||
        (codePoint >= 0x10000 && codePoint <= 0x10FFFF)) {
      return String.fromCodePoint(codePoint);
    }
    return reference;
  });
}

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`, 'i');
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = decodeXmlReferences(match[1].trim());
  return trimmed.trim() === '' ? null : trimmed;
}

function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`, 'i');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'gi');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = decodeXmlReferences(elementMatch[1].trim());
    if (trimmed.trim()) {
      elements.push(trimmed);
    }
  }

  return elements;
}

function extractUnstructuredObservationText(content: string): string | null {
  if (/<\/?(summary|skip_summary)\b/i.test(content)) {
    return null;
  }

  const stripped = content
    .replace(
      /<(type|title|subtitle|narrative|facts|concepts|files_read|files_modified)(?:\s*\/>|>[\s\S]*?<\/\1>)/gi,
      ' '
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('\n')
    .trim();

  return stripped === '' ? null : stripped;
}

function extractObservationFallback(text: string): { title: string; narrative: string | null } {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  const firstLine = lines[0] ?? text.trim();
  const firstLineGraphemes = Array.from(observationGraphemeSegmenter.segment(firstLine), part => part.segment);
  const hasOverflow = firstLineGraphemes.length > OBSERVATION_TITLE_MAX_GRAPHEMES;
  const title = hasOverflow
    ? `${firstLineGraphemes.slice(0, OBSERVATION_TITLE_TRUNCATE_AT).join('')}...`
    : firstLine;
  const narrativeLines = hasOverflow
    ? [firstLineGraphemes.slice(OBSERVATION_TITLE_TRUNCATE_AT).join('').trim(), ...lines.slice(1)]
    : lines.slice(1);
  const narrative = narrativeLines
    .filter(line => line !== '')
    .join('\n')
    .trim();

  return {
    title,
    narrative: narrative === '' ? null : narrative,
  };
}
