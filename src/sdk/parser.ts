
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

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

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
function normalizeObservationTitle(rawTitle: string): string {
  const trimmed = rawTitle.trim();
  const titleMatch = /^\[\*\*title\*\*:\s*/i.exec(trimmed);
  if (titleMatch) {
    const content = trimmed.slice(titleMatch[0].length).trim();
    const normalized = content.endsWith(']') ? content.slice(0, -1).trim() : content;
    // A bare Markdown label carries no title at all. Keep the record usable in
    // the UI without pretending that the model supplied semantic content.
    return normalized || 'Untitled observation';
  }

  const typedMatch = /^\[\*\*(?:bugfix|feature|refactor|change|discovery|decision|security_alert|security_note|sensitive)\*\*(?:\]\s*:?\s*|:\s*)/i.exec(trimmed);
  if (!typedMatch) return trimmed;
  const content = trimmed.slice(typedMatch[0].length).trim();
  const normalized = typedMatch[0].includes(':') && content.endsWith(']') ? content.slice(0, -1).trim() : content;
  return normalized || 'Untitled observation';
}

export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false };
  }

  raw = stripCodeFences(raw);

  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(raw);
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
        skip_reason: skipMatch[1] ?? null,
      },
    };
  }

  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    return { valid: false };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const observations = parseObservationBlocks(raw, correlationId);
    if (observations.length === 0) {
      return { valid: false };
    }
    return { valid: true, observations, summary: null };
  }

  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return { valid: false };
  }
  return { valid: true, observations: [], summary };
}

function parseObservationBlocks(text: string, correlationId?: string | number): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const rawTitle = extractField(obsContent, 'title');
    const title = rawTitle ? normalizeObservationTitle(rawTitle) : null;
    if (rawTitle && title !== rawTitle) {
      logger.warn('PARSER', `Normalized observation title wrapper: ${rawTitle.slice(0, 80)}`, { correlationId });
    }
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
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
      logger.error('PARSER', `Observation missing type field, using "${fallbackType}"`, { correlationId });
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

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
        correlationId,
        type: finalType
      });
      continue;
    }

    observations.push({
      type: finalType,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

function parseSummaryBlock(text: string, correlationId?: string | number): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];

  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); 

  if (!request && !investigated && !learned && !completed && !next_steps) {
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

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) {
      elements.push(trimmed);
    }
  }

  return elements;
}
