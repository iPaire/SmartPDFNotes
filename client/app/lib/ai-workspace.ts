/* eslint-disable @typescript-eslint/no-explicit-any -- LLM output is untyped JSON, shape-checked field by field below */
// lib/ai-workspace.ts - Server-only AI generators for the learning workspace.
//
// Every generator goes through createChatCompletion, inheriting the
// OpenAI-primary -> OpenAI-secondary -> Anthropic fallback chain and retries.
// gpt-4o-mini is used for all plans: it is cheaper than gpt-3.5-turbo, higher
// quality, and has a 128k context window. Plans differ by artifact size
// (see workspace-access.ts), not by model.
import { createChatCompletion } from './ai-client';

const WORKSPACE_MODEL = 'gpt-4o-mini';

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ro: 'Romanian',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
};

export interface DocContext {
  /** Text handed to the model (already truncated to budget). */
  text: string;
  /** 'document' when built from full extracted text, 'summary' otherwise. */
  source: 'document' | 'summary';
  /** ISO language code of the document. */
  language: string;
}

/**
 * Build the document context for generation. Prefers the full extracted PDF
 * text; falls back to the stored summary for legacy documents that predate
 * text persistence. Long texts keep the head (intro/definitions) and tail
 * (conclusions/recaps) split at paragraph boundaries - no chunking needed at
 * our <=4.5MB upload cap.
 */
export function buildDocContext(
  extractedText: string | null | undefined,
  summaryContent: string,
  language: string,
  budgetChars = 60_000
): DocContext {
  const source: DocContext['source'] = extractedText ? 'document' : 'summary';
  const raw = extractedText || summaryContent;

  if (raw.length <= budgetChars) {
    return { text: raw, source, language };
  }

  const headBudget = Math.floor(budgetChars * 0.7);
  const tailBudget = budgetChars - headBudget;

  let headEnd = raw.lastIndexOf('\n\n', headBudget);
  if (headEnd < headBudget * 0.5) headEnd = headBudget;

  let tailStart = raw.indexOf('\n\n', raw.length - tailBudget);
  if (tailStart === -1 || tailStart > raw.length - tailBudget * 0.5) {
    tailStart = raw.length - tailBudget;
  }

  const text = `${raw.slice(0, headEnd)}\n\n[...]\n\n${raw.slice(tailStart)}`;
  return { text, source, language };
}

function languageName(code: string): string {
  return LANGUAGE_NAMES[code] || 'English';
}

function systemPrompt(ctx: DocContext, task: string): string {
  return (
    `You are an expert tutor helping a student learn from a document. ${task} ` +
    `Write ALL output in ${languageName(ctx.language)}. ` +
    `Base everything strictly on the document content provided by the user. ` +
    `Respond ONLY with a single valid JSON object matching the requested shape - no markdown fences, no prose.`
  );
}

function parseJson(content: string): any {
  // Models occasionally wrap JSON in fences despite instructions.
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(cleaned);
}

// ---------------- Key concepts ----------------

export interface KeyConcept {
  term: string;
  definition: string;
  whyItMatters: string;
  example?: string;
}

export async function generateKeyConcepts(ctx: DocContext, count: number): Promise<{ concepts: KeyConcept[] }> {
  const result = await createChatCompletion({
    model: WORKSPACE_MODEL,
    system: systemPrompt(
      ctx,
      `Extract the ${count} most important concepts a student must understand from this document.`
    ),
    prompt:
      `Document:\n"""\n${ctx.text}\n"""\n\n` +
      `Return JSON: {"concepts": [{"term": string, "definition": string (1-2 sentences, clear and simple), ` +
      `"whyItMatters": string (1 sentence on why this concept is important), ` +
      `"example": string (optional short concrete example)}]}\n` +
      `Return between ${Math.max(5, count - 5)} and ${count} concepts, most important first.`,
    maxTokens: 3000,
    temperature: 0.4,
    jsonMode: true,
  });

  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed?.concepts) || parsed.concepts.length === 0) {
    throw new Error('AI returned invalid key concepts shape');
  }
  return {
    concepts: parsed.concepts
      .filter((c: any) => typeof c?.term === 'string' && typeof c?.definition === 'string')
      .slice(0, count)
      .map((c: any) => ({
        term: c.term,
        definition: c.definition,
        whyItMatters: typeof c.whyItMatters === 'string' ? c.whyItMatters : '',
        ...(typeof c.example === 'string' && c.example ? { example: c.example } : {}),
      })),
  };
}

// ---------------- Flashcards ----------------

export interface Flashcard {
  front: string;
  back: string;
}

export async function generateFlashcards(ctx: DocContext, count: number): Promise<{ cards: Flashcard[] }> {
  const result = await createChatCompletion({
    model: WORKSPACE_MODEL,
    system: systemPrompt(
      ctx,
      `Create ${count} study flashcards covering the most testable facts, definitions and relationships in this document.`
    ),
    prompt:
      `Document:\n"""\n${ctx.text}\n"""\n\n` +
      `Return JSON: {"cards": [{"front": string (a question, term or prompt - short), ` +
      `"back": string (the answer - concise but complete)}]}\n` +
      `Return exactly ${count} cards if the material allows. Vary the card styles: definitions, ` +
      `"what is the difference between", fill-in-the-blank, cause/effect.`,
    maxTokens: 3000,
    temperature: 0.5,
    jsonMode: true,
  });

  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed?.cards) || parsed.cards.length === 0) {
    throw new Error('AI returned invalid flashcards shape');
  }
  return {
    cards: parsed.cards
      .filter((c: any) => typeof c?.front === 'string' && typeof c?.back === 'string')
      .slice(0, count),
  };
}

// ---------------- Important questions ----------------

export interface ImportantQuestion {
  question: string;
  modelAnswer: string;
  difficulty: 'basic' | 'intermediate' | 'advanced';
}

export async function generateImportantQuestions(
  ctx: DocContext,
  count: number
): Promise<{ questions: ImportantQuestion[] }> {
  const result = await createChatCompletion({
    model: WORKSPACE_MODEL,
    system: systemPrompt(
      ctx,
      `Write ${count} open-ended exam-style questions a professor would most likely ask about this document, with model answers.`
    ),
    prompt:
      `Document:\n"""\n${ctx.text}\n"""\n\n` +
      `Return JSON: {"questions": [{"question": string, ` +
      `"modelAnswer": string (a complete answer that would earn full marks, 2-5 sentences), ` +
      `"difficulty": "basic" | "intermediate" | "advanced"}]}\n` +
      `Return exactly ${count} questions, mixing difficulties. These are open questions, NOT multiple choice.`,
    maxTokens: 3200,
    temperature: 0.5,
    jsonMode: true,
  });

  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed?.questions) || parsed.questions.length === 0) {
    throw new Error('AI returned invalid important questions shape');
  }
  const allowed = new Set(['basic', 'intermediate', 'advanced']);
  return {
    questions: parsed.questions
      .filter((q: any) => typeof q?.question === 'string' && typeof q?.modelAnswer === 'string')
      .slice(0, count)
      .map((q: any) => ({
        question: q.question,
        modelAnswer: q.modelAnswer,
        difficulty: allowed.has(q.difficulty) ? q.difficulty : 'intermediate',
      })),
  };
}

// ---------------- Study notes ----------------

export async function generateStudyNotes(ctx: DocContext): Promise<{ markdown: string }> {
  const result = await createChatCompletion({
    model: WORKSPACE_MODEL,
    system: systemPrompt(
      ctx,
      `Write condensed, well-structured revision notes for this document - the notes a top student would make before an exam.`
    ),
    prompt:
      `Document:\n"""\n${ctx.text}\n"""\n\n` +
      `Return JSON: {"markdown": string}\n` +
      `The markdown must use: ## section headings, bullet points, **bold** for key terms, ` +
      `and LaTeX for ALL formulas and mathematical notation - inline between single dollar signs ` +
      `($v = \\\\lambda f$) and important equations between double dollar signs. Never write math ` +
      `as plain text or backticks. Keep it scannable - short lines, no long paragraphs. ` +
      `Cover the whole document, prioritizing what is most likely to be tested.`,
    maxTokens: 3500,
    temperature: 0.4,
    jsonMode: true,
  });

  const parsed = parseJson(result.content);
  if (typeof parsed?.markdown !== 'string' || parsed.markdown.length < 50) {
    throw new Error('AI returned invalid study notes shape');
  }
  return { markdown: parsed.markdown };
}

// ---------------- Quiz ----------------

// Matches the shape stored in File.quiz by /api/summarize, so the workspace
// QuizTab renders upload-time and on-demand quizzes identically.
export interface WorkspaceQuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation?: string;
}

export async function generateWorkspaceQuiz(
  ctx: DocContext,
  count: number
): Promise<{ questions: WorkspaceQuizQuestion[] }> {
  const result = await createChatCompletion({
    model: WORKSPACE_MODEL,
    system: systemPrompt(
      ctx,
      `Create a ${count}-question multiple-choice quiz that tests real understanding of this document.`
    ),
    prompt:
      `Document:\n"""\n${ctx.text}\n"""\n\n` +
      `Return JSON: {"questions": [{"question": string, "options": string[] (exactly 4 plausible options), ` +
      `"correctAnswer": number (0-based index of the correct option), ` +
      `"explanation": string (1-2 sentences on why the answer is correct)}]}\n` +
      `Return exactly ${count} questions. Distractors must be plausible, not obviously wrong.`,
    maxTokens: 3200,
    temperature: 0.5,
    jsonMode: true,
  });

  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed?.questions) || parsed.questions.length === 0) {
    throw new Error('AI returned invalid quiz shape');
  }
  return {
    questions: parsed.questions
      .filter(
        (q: any) =>
          typeof q?.question === 'string' &&
          Array.isArray(q?.options) &&
          q.options.length >= 2 &&
          typeof q?.correctAnswer === 'number' &&
          q.correctAnswer >= 0 &&
          q.correctAnswer < q.options.length
      )
      .slice(0, count),
  };
}
