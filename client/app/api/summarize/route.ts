import { NextRequest } from 'next/server';
import { after } from 'next/server';

// Large documents spend most of this on the two LLM calls (summary + quiz);
// the post-response diagram rendering needs the remaining budget. 300s is
// supported on Vercel with Fluid Compute (default) - if the deploy rejects
// it, drop back to 60.
export const maxDuration = 300;
import { createHash } from 'crypto';
import pdf from 'pdf-parse';
import { generateDiagramsArtifact } from '@/lib/pdf-diagrams';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { createChatCompletion } from "@/lib/ai-client";
import { cacheGet, cacheSet, cacheKey } from "@/lib/cache";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { downloadUpload, deleteUpload } from "@/lib/supabase-storage";
import { getErrorMessage } from '@/lib/errors';

// Minimal shape of the pdf.js page object that pdf-parse hands to `pagerender`.
type PdfPageData = {
  getTextContent(options: {
    normalizeWhitespace: boolean;
    disableCombineTextItems: boolean;
  }): Promise<{ items: { str: string; transform: number[] }[] }>;
};

// Distributed (Redis) cache for identical documents - survives cold starts
// and is shared across serverless instances, unlike the old in-memory Map.
// The cache is content-addressed (hash of the full document text + settings),
// so entries can never be "wrong" for their inputs - the TTL only bounds how
// long an outdated prompt style survives a deploy, and Redis storage size.
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

// Bump whenever the summary/quiz prompts change materially, so stale-format
// entries are not served after a deploy.
// v2: adaptive document-driven prompts + LaTeX math output (KaTeX-rendered)
// v3: gpt-4o-mini for all tiers, full-document input budget (no more
//     first-pages-only truncation), boilerplate stripping, worked-examples rule
// v4: anti-hallucination rule for table-of-contents-only chapters; worked
//     examples must show every calculation step or admit they are unsolved
// v5: hard skip rule for TOC-only chapters (no one-sentence stubs),
//     gpt-4.1-mini for standard/premium (better instruction adherence)
const PROMPT_VERSION = 'v5';

interface CachedSummary {
  summary: string;
  quiz: QuizQuestion[];
}

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
}

export async function POST(request: NextRequest) {
  // Check authentication
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new Response(
      JSON.stringify({ error: 'Trebuie să fii autentificat pentru a utiliza acest serviciu' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Request-level rate limit (per user) on top of the monthly usage quota,
  // so a single user can't hammer the expensive LLM pipeline.
  const rateLimit = await checkRateLimit('ai', session.user.id);
  if (!rateLimit.success) {
    return rateLimitResponse(rateLimit, 'Prea multe solicitări. Te rugăm să aștepți un minut înainte de a încerca din nou.');
  }

  try {
    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: { 
        usage: { 
          where: { 
            date: { 
              gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
              lt: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
            } 
          } 
        } 
      }
    });

    if (!user) {
      return new Response(
        JSON.stringify({ error: 'Utilizatorul nu a fost găsit' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Check usage limits
    const usageCount = user.usage.length;
    const planLimits = {
      free: 3,
      trial: 10,
      standard: 25,
      premium: 50
    };
    const userLimit = planLimits[user.subscription as keyof typeof planLimits] || 0;

    if (usageCount >= userLimit) {
      return new Response(
        JSON.stringify({ 
          error: `Ai atins limita lunară de ${userLimit} rezumate. ${userLimit === 3 ? 'Trebuie să îți faci upgrade pentru a continua.' : 'Te rugăm să aștepți până la resetarea lunară.'}` 
        }), 
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Two intake modes:
    // - multipart/form-data with the PDF inline (small files)
    // - application/json { storagePath, filename, summaryLength } for large
    //   files the browser uploaded directly to Supabase Storage, because
    //   Vercel caps function request bodies at 4.5MB.
    let buffer: ArrayBuffer;
    let filename: string;
    let summaryLength: string;

    const intakeType = request.headers.get('content-type') || '';
    if (intakeType.includes('application/json')) {
      const body = await request.json();
      const storagePath = typeof body.storagePath === 'string' ? body.storagePath : '';
      filename = typeof body.filename === 'string' ? body.filename : '';
      summaryLength = typeof body.summaryLength === 'string' ? body.summaryLength : 'long';

      if (!storagePath || !filename) {
        return new Response(
          JSON.stringify({ error: 'Niciun fișier PDF încărcat' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Uploads are keyed under the owner's user id by /api/upload-url.
      if (!storagePath.startsWith(`${user.id}/`)) {
        return new Response(
          JSON.stringify({ error: 'Acces interzis la acest fișier' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }

      try {
        buffer = await downloadUpload(storagePath);
      } catch (error) {
        console.error('[summarize] storage download failed:', error);
        return new Response(
          JSON.stringify({ error: 'Nu am putut prelua fișierul încărcat. Încearcă din nou.' }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // The buffer is all we need; clean up the transient upload now.
      deleteUpload(storagePath).catch(() => {});

      const planSizeLimitsMb: Record<string, number> = { free: 10, trial: 25, standard: 50, premium: 50 };
      const maxMb = planSizeLimitsMb[user.subscription || 'free'] ?? 10;
      if (buffer.byteLength > maxMb * 1024 * 1024) {
        return new Response(
          JSON.stringify({ error: `Fișierul depășește limita de ${maxMb}MB a planului tău` }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // Process file size
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
        return new Response(
          JSON.stringify({ error: 'Fișierul depășește limita de 10MB' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Process file upload
      const formData = await request.formData();
      const file = formData.get('pdf') as Blob | null;
      const formFilename = formData.get('filename') as string | null;
      summaryLength = (formData.get('summaryLength') as string | null) || 'long';

      if (!file || !formFilename) {
        return new Response(
          JSON.stringify({ error: 'Niciun fișier PDF încărcat' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      filename = formFilename;

      if (file.type !== 'application/pdf') {
        return new Response(
          JSON.stringify({ error: 'Tip fișier invalid. Vă rugăm să încărcați doar PDF-uri.' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      buffer = await file.arrayBuffer();
    }

    const fileSize = buffer.byteLength;
    const header = new Uint8Array(buffer, 0, 4);
    const headerHex = Array.from(header).map(b => b.toString(16).padStart(2, '0')).join('');
    if (headerHex !== '25504446') {
      return new Response(
        JSON.stringify({ error: 'Fișierul nu este un PDF valid' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Strips per-page boilerplate BEFORE truncation and caching: repeated
    // headers/footers (course name, professor, chapter line on every slide)
    // and bare page-number lines. On slide decks this noise can eat 30% of
    // the model's input budget before any real content reaches it.
    function stripBoilerplate(raw: string, pages: number): string {
      const lines = raw.split('\n');
      const counts = new Map<string, number>();
      for (const line of lines) {
        const key = line.trim();
        if (key.length >= 8 && key.length <= 120) {
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      // A line repeated on a third of the pages (min 4) is a header/footer.
      const repeatedThreshold = Math.max(4, Math.floor(pages / 3));
      const kept = lines.filter((line) => {
        const key = line.trim();
        if (/^\d{1,4}$/.test(key)) return false; // bare page number
        if (key.length >= 8 && key.length <= 120 && (counts.get(key) || 0) >= repeatedThreshold) return false;
        return true;
      });
      return kept.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    // Parse PDF. The custom pagerender replicates pdf-parse's default line
    // assembly exactly (so data.text - and therefore cache keys and content
    // hashes - are unchanged) while also capturing per-page text for the
    // diagram-page detection heuristic.
    let text = '';
    let numpages = 0;
    const pageTexts: string[] = [];

    try {
      const data = await pdf(Buffer.from(buffer), {
        pagerender: (pageData: PdfPageData) =>
          pageData
            .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
            .then((textContent) => {
              let lastY: number | undefined;
              let pageText = '';
              for (const item of textContent.items) {
                if (lastY === item.transform[5] || lastY === undefined) {
                  pageText += item.str;
                } else {
                  pageText += '\n' + item.str;
                }
                lastY = item.transform[5];
              }
              pageTexts.push(pageText);
              return pageText;
            }),
      });
      numpages = data.numpages;
      text = stripBoilerplate(data.text, numpages);
    } catch (parseError) {
      console.error('Eroare parsare PDF:', parseError);
      return new Response(
        JSON.stringify({ error: 'Nu am putut extrage textul din PDF. Fișierul este protejat sau conține imagini.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!text.trim()) {
      return new Response(
        JSON.stringify({ error: 'PDF-ul conține doar imagini. Nu putem extrage text.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Same document re-uploaded by the same user -> return the existing
    // workspace instead of creating a duplicate summary. Doesn't consume
    // quota and skips the whole AI pipeline.
    const contentHash = createHash('sha256').update(text).digest('hex');
    const existingFile = await prisma.file.findFirst({
      where: { userId: user.id, contentHash },
      include: { summaryRec: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (existingFile?.summaryRec) {
      return new Response(
        JSON.stringify({
          summary: existingFile.summary,
          quiz: existingFile.quiz,
          fileID: existingFile.id,
          summaryId: existingFile.summaryRec.id,
          duplicate: true,
          meta: {
            filename,
            pages: existingFile.pages,
            size: fileSize,
            characters: text.length,
            language: existingFile.language,
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Fast language detection using simple heuristics
    function detectLanguageFast(text: string): string {
      const sample = text.substring(0, 500).toLowerCase();
      
      // Romanian indicators
      if (/\b(și|cu|de|în|pe|la|pentru|din|sau|dacă|este|sunt|avea|care|acest|această)\b/.test(sample)) {
        return 'ro';
      }
      // English indicators  
      if (/\b(and|with|the|for|from|or|if|is|are|have|which|this|that)\b/.test(sample)) {
        return 'en';
      }
      // French indicators
      if (/\b(et|avec|de|dans|sur|pour|ou|si|est|sont|avoir|qui|ce|cette)\b/.test(sample)) {
        return 'fr';
      }
      // German indicators
      if (/\b(und|mit|der|die|das|in|auf|für|oder|wenn|ist|sind|haben|welche|diese)\b/.test(sample)) {
        return 'de';
      }
      // Spanish indicators
      if (/\b(y|con|de|en|por|para|o|si|es|son|tener|que|este|esta)\b/.test(sample)) {
        return 'es';
      }
      
      return 'en'; // default
    }

    // Subscription-based configuration. All tiers use gpt-4o-mini: it is
    // cheaper than gpt-3.5-turbo, follows the LaTeX/structure instructions
    // far better, and its 128k context window lets us feed whole documents
    // instead of the first few pages. Tiers differ via input budget,
    // output length and sections - not model quality.
    const baseConfig = {
      free: {
        model: 'gpt-4o-mini',
        temperature: 0.1,
        sections: ['basic'],
        maxQuestions: 0,
        inputCharLimit: 60_000
      },
      trial: {
        model: 'gpt-4o-mini',
        temperature: 0.3,
        sections: ['trial'],
        maxQuestions: 5,
        inputCharLimit: 120_000
      },
      standard: {
        // 4.1-mini follows the faithfulness/worked-example rules much more
        // reliably than 4o-mini, at a still-small cost.
        model: 'gpt-4.1-mini',
        temperature: 0.3,
        sections: ['standard'],
        maxQuestions: 5,
        inputCharLimit: 150_000
      },
      premium: {
        model: 'gpt-4.1-mini',
        temperature: 0.2, // Slightly lower for faster response
        sections: ['premium'],
        maxQuestions: 12,
        inputCharLimit: 250_000
      }
    };

    // Adjust tokens based on summary length
    let tokenMultiplier = 1;
    if (summaryLength === 'short') {
      tokenMultiplier = 0.6;
    } else if (summaryLength === 'academic') {
      tokenMultiplier = 1.5; // Academic summaries need more tokens
    }
    const subscriptionConfig = Object.fromEntries(
      Object.entries(baseConfig).map(([plan, config]) => [
        plan,
        {
          ...config,
          maxTokens: Math.floor((plan === 'free' ? 1500 : plan === 'premium' ? 3000 : 2500) * tokenMultiplier)
        }
      ])
    );

    const config = subscriptionConfig[user.subscription as keyof typeof subscriptionConfig] || subscriptionConfig.free;
    const summaryModel = config.model;
    const maxTokens = config.maxTokens;
    const temperature = config.temperature;

    // Fast language detection without API call
    const documentLanguage = detectLanguageFast(text);

    // Map language to full name for prompts
    const languageMap: Record<string, string> = {
      en: 'engleză',
      ro: 'română',
      fr: 'franceză',
      de: 'germană',
      es: 'spaniolă',
      it: 'italiană'
    };

    const targetLanguage = languageMap[documentLanguage] || 'engleză';

    // Cache key over the FULL document text (the old md5-of-first-1000-chars
    // key collided for documents sharing a title page), plus every setting
    // that changes the output.
    const summaryCacheKey = cacheKey(
      'summary',
      PROMPT_VERSION,
      text,
      user.subscription || 'free',
      summaryLength,
      documentLanguage
    );

    // Check the distributed cache first
    const cached = await cacheGet<CachedSummary>(summaryCacheKey);
    if (cached) {
      console.log('Cache hit - returning cached summary and quiz');

      // Still record usage and create records. File first so the Summary can
      // link to it (fileId powers the learning workspace).
      const [, fileRecord] = await Promise.all([
        prisma.usage.create({ data: { userId: user.id } }),
        prisma.file.create({
          data: {
            userId: user.id,
            name: filename,
            size: fileSize,
            pages: numpages,
            characters: text.length,
            summary: cached.summary,
            quiz: cached.quiz as unknown as Prisma.InputJsonValue,
            language: documentLanguage,
            extractedText: text.slice(0, 1_500_000),
            contentHash
          }
        })
      ]);
      const summaryRecord = await prisma.summary.create({
        data: {
          title: `${languageMap[documentLanguage] || 'Summary'} ${filename.substring(0, 30)}`,
          content: cached.summary,
          language: documentLanguage,
          userId: user.id,
          fileId: fileRecord.id,
        }
      });
      // Tells the user their summary landed in the Library even if they
      // navigated away while it was processing.
      await prisma.notification.create({
        data: {
          userId: user.id,
          type: 'summary_ready',
          payload: { title: summaryRecord.title },
          href: `/workspace/${summaryRecord.id}`,
        },
      }).catch((e) => console.error('[summarize] notification create failed:', e));

      // Diagram pages render AFTER the response is sent - they must never
      // slow down or break the summary flow.
      after(() => generateDiagramsArtifact(summaryRecord.id, user.id, buffer, pageTexts));

      return new Response(
        JSON.stringify({
          summary: cached.summary,
          quiz: cached.quiz,
          fileID: fileRecord.id,
          summaryId: summaryRecord.id,
          meta: { filename, pages: numpages, size: fileSize, characters: text.length, language: targetLanguage }
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Input budget is decoupled from output tokens (the old maxTokens*2.5
    // formula fed the model only the first ~2-3 pages of any real document,
    // which is why summaries missed formulas and worked examples entirely).
    // gpt-4o-mini's 128k context fits whole course PDFs; the per-plan cap
    // only bounds cost. Oversized documents keep head (intro/definitions)
    // and tail (applications/recaps) split at paragraph boundaries.
    const maxInputChars = config.inputCharLimit;
    let truncatedText = text;

    if (text.length > maxInputChars) {
      const headBudget = Math.floor(maxInputChars * 0.7);
      const tailBudget = maxInputChars - headBudget;

      let headEnd = text.lastIndexOf('\n\n', headBudget);
      if (headEnd < headBudget * 0.5) headEnd = headBudget;

      let tailStart = text.indexOf('\n\n', text.length - tailBudget);
      if (tailStart === -1 || tailStart > text.length - tailBudget * 0.5) {
        tailStart = text.length - tailBudget;
      }

      truncatedText = `${text.substring(0, headEnd)}\n\n[...]\n\n${text.substring(tailStart)}`;
    }

    // Enhanced technical content extraction with better formula detection
    function extractTechnicalContent(text: string) {
      // Enhanced formula detection patterns
      const formulaPatterns = [
        /[A-Za-z_]+\s*[=≈≤≥]\s*[A-Za-z0-9\s+\-*/()^.\\frac{}]+/g,
        /\\frac\{[^}]+\}\{[^}]+\}/g,
        /[A-Za-z_]+_{[^}]+}\s*[=≈]/g,
        /[A-Za-z_]+\^{?[A-Za-z0-9]+}?\s*[=≈]/g,
        /I_[a-zA-Z]+\s*=|R_[a-zA-Z]+\s*=|U_[a-zA-Z]+\s*=/g
      ];

      let allFormulas: string[] = [];
      formulaPatterns.forEach(pattern => {
        const matches = text.match(pattern) || [];
        allFormulas = [...allFormulas, ...matches];
      });

      // Remove duplicates and limit to most important ones
      const formulas = [...new Set(allFormulas)].slice(0, 5);
      const formulaCount = formulas.length;

      // Count technical terms
      const technicalTerms = (text.match(/\b[A-Z][a-z]*(?:[A-Z][a-z]*)*\b/g) || []).length;

      // Check if document has meaningful mathematical content
      const hasMeaningfulFormulas = formulaCount >= 3 ||
        /\b(ecuația|formula|calculul|teorema|principiul)\b/i.test(text) ||
        /\b(equation|formula|calculation|theorem|principle)\b/i.test(text);

      return {
        formulas,
        formulaCount,
        technicalTerms: Math.min(technicalTerms, 30),
        numericalValues: [],
        hasMeaningfulFormulas
      };
    }
    
    // Funcție pentru îmbunătățirea formatării și structurii
    function improveFormatting(summary: string): string {
      let improved = summary;

      // Înlocuiește date placeholder cu date reale
      const currentDate = new Date().toLocaleDateString('ro-RO');
      improved = improved.replace(/\[data curentă\]/g, currentDate);
      improved = improved.replace(/\[data generării\]/g, currentDate);
      improved = improved.replace(/\[nume fisier\]/g, filename ?? "");
      improved = improved.replace(/\[numar pagini\]/g, numpages.toString());

      // Îmbunătățește formatarea titlurilor pentru a fi consistentă
      improved = improved.replace(/^(#{1,3})\s*\*\*([^*]+)\*\*$/gm, '$1 **$2**\n');

      // Asigură spații adecvate între secțiuni
      improved = improved.replace(/(#{1,3}[^\n]*)\n{0,1}([^#\n])/g, '$1\n\n$2');

      // Get formula label based on document language
      const formulaLabels: Record<string, string> = {
        en: 'Formula',
        ro: 'Formulă',
        fr: 'Formule',
        es: 'Fórmula',
        de: 'Formel',
        it: 'Formula'
      };
      const formulaLabel = formulaLabels[documentLanguage] || 'Formula';

      // New prompts emit real LaTeX ($...$ / $$...$$) rendered by KaTeX.
      // The regex-based formula wrapping below is only for legacy output and
      // would corrupt LaTeX, so skip it when math delimiters are present.
      const hasLatexMath = /\$[^$\n]+\$|\$\$[\s\S]+?\$\$/.test(improved);

      // Îmbunătățește formatarea formulelor - wrap them in code blocks without the "Formula:" prefix
      // The prefix is added by the frontend based on UI language
      // Pentru formule simple cu egale - wrap in backticks without label
      if (!hasLatexMath) improved = improved.replace(/([A-Za-z_]+\s*[=≈≤≥<>]\s*[A-Za-z0-9\s+\-*/()^.\\{}]+)(?=\s|$|\n)/g, (match) => {
        // Skip if already wrapped or is part of a label
        if (match.includes('`') || match.includes(`**${formulaLabel}:**`)) {
          return match;
        }
        return `\n\n\`${match.trim()}\`\n`;
      });

      // Pentru formule LaTeX - wrap in backticks without label
      if (!hasLatexMath) improved = improved.replace(/(\\frac\{[^}]+\}\{[^}]+\})/g, (match) => {
        if (match.includes('`')) return match;
        return `\n\n\`${match}\`\n`;
      });

      // Pentru formule cu indici - wrap in backticks without label
      if (!hasLatexMath) improved = improved.replace(/([A-Za-z_]+_{[^}]+}[^a-zA-Z]*[=≈≤≥<>][^=]*)/g, (match) => {
        if (match.includes('`') || match.includes(`**${formulaLabel}:**`)) {
          return match;
        }
        return `\n\n\`${match.trim()}\`\n`;
      });
      
      // Formatare îmbunătățită pentru tabele - asigură header corect și separatori
      // First, remove all existing separator rows
      improved = improved.replace(/^\s*\|[\s\-:|]+\|\s*$/gm, '');

      // Clean up extra newlines after separator removal
      improved = improved.replace(/(\|[^\n]+\|)\n\n+(\|[^\n]+\|)/g, '$1\n$2');

      // Add proper table separators after header rows
      // Match any table row (with any number of columns) followed by a data row
      improved = improved.replace(/(\|[^\n]+\|)\n(\|(?!\s*-)[^\n]+\|)/g, (match, header, nextRow) => {
        // Count the number of columns in the header
        const columnCount = (header.match(/\|/g) || []).length - 1;
        // Generate separator with correct number of columns
        const separator = '|' + ' --- |'.repeat(columnCount);
        return `${header}\n${separator}\n${nextRow}`;
      });
      
      // Evidențiază valorile numerice cu unități (ar strica LaTeX-ul, deci
      // doar pentru output legacy fără $...$). Spațiul dintre număr și
      // unitate e OBLIGATORIU, altfel regexul prindea numerotarea de
      // secțiuni ("6.1. Considerații" -> "**1. Considera**ții"); lookahead-ul
      // include diacriticele românești ca să nu taie cuvinte la mijloc.
      if (!hasLatexMath) improved = improved.replace(
        /(?<![\w.])(\d+(?:[.,]\d+)?)\s+([A-Za-zΩ%µ]{1,4})(?![\wțșăîâȚȘĂÎÂ])/g,
        '**$1 $2**'
      );
      
      // Îmbunătățește formatarea listelor - asigură consistență
      improved = improved.replace(/^(\s*-)(\s*)/gm, '- ');
      improved = improved.replace(/^(\s*)(\d+\.)(\s*)/gm, '$1$2 ');
      
      // Curăță duplicatele de spații și linii goale dar păstrează structura
      improved = improved.replace(/\n{4,}/g, '\n\n\n');
      improved = improved.replace(/\s+$/gm, '');
      
      // Asigură că formulele sunt separate proper (using dynamic formula label)
      const escapedLabel = formulaLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const formulaPattern = new RegExp(`(\\*\\*${escapedLabel}:\\*\\*[^\\n]*)\\n([^\\n*#])`, 'g');
      improved = improved.replace(formulaPattern, '$1\n\n$2');

      return improved.trim();
    }
    
    // Funcție pentru validarea calității
    function validateSummaryQuality(summary: string, originalText: string): { score: number; issues: string[] } {
      const issues: string[] = [];
      let score = 100;
      
      // Verifică dacă conține formule (doar pentru documente tehnice)
      if (originalText.length > 1000 && /[A-Za-z]+\s*[=≈]/.test(originalText)) {
        if (!/[A-Za-z]+\s*[=≈]/.test(summary)) {
          issues.push("Lipsesc formulele matematice din original");
          score -= 20;
        }
      }
      
      // Verifică lungimea relativă - mai flexibil pentru rezumate scurte
      const minRatio = summaryLength === 'short' ? 0.05 : 0.08;
      if (summary.length < originalText.length * minRatio) {
        issues.push(`Rezumatul pare prea scurt pentru tipul ${summaryLength}`);
        score -= 15;
      }
      
      // Verifică structura - să aibă cel puțin 2 secțiuni
      const sectionCount = (summary.match(/#{1,3}|^\d+\./gm) || []).length;
      if (sectionCount < 2) {
        issues.push("Structura pare prea simplă");
        score -= 10;
      }
      
      // Verifică dacă are conținut duplicat evident
      const sentences = summary.split(/[.!?]+/);
      const duplicates = sentences.filter((sentence, index) => 
        sentence.length > 20 && sentences.indexOf(sentence) !== index
      );
      if (duplicates.length > 0) {
        issues.push("Conține conținut duplicat");
        score -= 25;
      }
      
      return { score, issues };
    }
    
    const technicalContent = extractTechnicalContent(text);

    // Function to generate adaptive section content based on document type
    function getAdaptiveSectionContent(planType: string, hasMathContent: boolean) {
      if (hasMathContent) {
        // For mathematical documents, use formula sections
        if (planType === 'basic') {
          return {
            title: 'Formule Esențiale',
            content: `Pentru formulele principale identificate în text:

**Formulă:** \`[formula exactă din text]\`
- Aplicare: [context scurt]`,
            question: 'Întrebare despre formulă'
          };
        } else if (planType === 'trial') {
          return {
            title: 'Formule Principale (Selecție Trial)',
            content: `Pentru MAXIM 4-5 formule principale identificate în text:

**Formulă:** \`[formula exactă din text]\`
- Variabile: [explicații scurte]
- Aplicare: [context esențial]`,
            question: 'Întrebare despre formulă'
          };
        } else { // standard
          return {
            title: 'Formule și Relații Matematice (Selecție Standard)',
            content: `Pentru MAXIM 8-10 formule principale identificate în text:

**Formulă:** \`[formula exactă din text]\`
- Variabile și parametri: [explicații moderate]
- Context de aplicare: [când și cum se folosește]`,
            question: 'Întrebare despre formulă'
          };
        }
      } else {
        // For non-mathematical documents, use procedural/practical sections
        if (planType === 'basic') {
          return {
            title: 'Proceduri și Implementări',
            content: `Pentru metodele și procedurile principale:

**Procedură:** [nume procedură]
- Pași: [pași principali]
- Aplicare: [când se folosește]`,
            question: 'Întrebare despre proceduri'
          };
        } else if (planType === 'trial') {
          return {
            title: 'Implementări Practice și Metode',
            content: `Pentru metodele și implementările principale:

**Metodă:** [nume metodă]
- Descriere: [cum funcționează]
- Avantaje: [beneficii principale]
- Limitări: [când nu se aplică]`,
            question: 'Întrebare despre implementări'
          };
        } else { // standard
          return {
            title: 'Analiză Tehnică și Implementări',
            content: `Pentru fiecare implementare tehnică principală:

**Tehnică:** [nume tehnică]
- Principiul de funcționare: [cum lucrează]
- Parametri critici: [factori importanți]
- Cazuri de utilizare: [aplicații practice]
- Performanțe: [rezultate așteptate]`,
            question: 'Întrebare despre implementări'
          };
        }
      }
    }

    // Section generation prompts based on subscription tier and length
    let wordLimit: string;
    if (summaryLength === 'short') {
      wordLimit = user.subscription === 'free' ? '800 cuvinte' : 
                  user.subscription === 'trial' ? '900 cuvinte' : '1000 cuvinte';
    } else if (summaryLength === 'academic') {
      wordLimit = user.subscription === 'premium' ? '4000 cuvinte' : '3000 cuvinte';
    } else {
      wordLimit = user.subscription === 'free' ? '1500 cuvinte' : 
                  user.subscription === 'trial' ? '1750 cuvinte' :
                  user.subscription === 'premium' ? '2500 cuvinte' : '2000 cuvinte';
    }

    // Shared rules for every tier. The old prompts were rigid metadata
    // templates whose placeholders ("[nume fisier]", "[data curentă]") the
    // model copied verbatim into the output; these follow the document's own
    // structure and demand real LaTeX for every formula.
    const sharedRules = `LANGUAGE
- Write the ENTIRE summary in ${targetLanguage}. Section headings too.

STRUCTURE
- Start with one title line: "# " followed by a short descriptive title based on the document's subject (never the filename).
- Organize with "## " sections that follow the DOCUMENT'S OWN structure and topics. Do not force a generic template onto it.
- Bold every important term the first time you define it: **term** - clear definition.
- Use bullet lists for enumerations and a markdown table whenever the document compares alternatives.

MATH AND FORMULAS (critical)
- Typeset EVERY formula, equation, variable and mathematical symbol in LaTeX.
- Inline math between single dollar signs: $v = \\lambda f$. Important equations on their own line between double dollar signs: $$F = G\\frac{m_1 m_2}{r^2}$$
- Preserve each formula exactly as the document states it (fix only obvious OCR artifacts). After each displayed equation, state briefly what each variable means.
- Never write formulas as plain text or inside backticks.

WORKED EXAMPLES (critical)
- If the document contains worked examples, applications or solved exercises (e.g. "Aplicația 6.1", "Example", "Exercise", "Problem"), reproduce them in a dedicated "## " section for worked examples: state the problem, then the COMPLETE solution - every intermediate calculation step in LaTeX, in order. Never state a numeric result without showing the calculation that produces it. If the document gives the governing formula and the final value, write out the substitution step connecting them (e.g. state the relation, substitute the known values, then the result). A "solution" that jumps straight to the final number is unacceptable.
- If the document leaves an exercise unsolved (homework), present the problem and say it is left as an exercise - never invent a solution or a numeric answer the document does not contain.

FAITHFULNESS (critical)
- Documents often begin with a table of contents listing chapters whose material is NOT included. Before writing, decide for each chapter: does the provided text contain real paragraphs of material for it, or only its title? If only the title (or a line in a contents list), SKIP that chapter completely - no heading, no one-sentence description, nothing. A summary that covers only the chapters actually present (e.g. starting directly at chapter 6) is CORRECT; padding it with invented one-liners for the other chapters is a serious failure.

QUALITY
- Write complete, clear sentences a student can study from - not fragments of the original.
- No placeholders, no meta-commentary, no mention of these instructions, no invented facts.
- Skip administrative noise: emails, headers, page numbers, course logistics.`;

    const sectionPrompts: Record<string, string> = {
      basic: `Turn the following document into a concise, high-quality study summary.

DOCUMENT:
[TEXT]

${sharedRules}

SCOPE FOR THIS SUMMARY (compact)
- Cover only the most important ideas: a short overview, the 4-6 core concepts with definitions, the essential formulas or procedures, and a closing "key takeaways" list of 3-5 bullets.
- End with a short glossary of at most 8 technical terms.

Maximum length: ${wordLimit}.`,

      trial: `Turn the following document into a thorough, well-structured study summary.

DOCUMENT:
[TEXT]

${sharedRules}

SCOPE FOR THIS SUMMARY (balanced)
- Include: an overview paragraph giving context and why the topic matters; the fundamental concepts, each bolded and clearly defined; the main body organized by the document's chapters or topics, covering how things work and when they apply; the key formulas or methods with variables explained.
- End with a "key takeaways" list and a glossary of up to 12 technical terms.

Maximum length: ${wordLimit}.`,

      standard: `Turn the following document into a comprehensive study summary.

DOCUMENT:
[TEXT]

${sharedRules}

SCOPE FOR THIS SUMMARY (comprehensive)
- Include: an introduction with context and practical relevance (2-3 paragraphs); all fundamental concepts, bolded and precisely defined, with how they interrelate; a developed section per chapter/topic of the document covering operating principles, applications and limitations; every important formula, each with its variables explained; comparison tables where the document contrasts methods or types.
- End with a "key takeaways" list and a glossary of up to 20 technical terms.

Maximum length: ${wordLimit}.`,

      premium: `Turn the following document into ${summaryLength === 'short' ? 'a sharp, concise study summary that captures everything essential' : summaryLength === 'academic' ? 'an exhaustive, academic-grade study summary' : 'a complete, in-depth study summary'}.

DOCUMENT:
[TEXT]

${sharedRules}

SCOPE FOR THIS SUMMARY (${summaryLength === 'short' ? 'premium concise' : summaryLength === 'academic' ? 'premium academic' : 'premium complete'})
${summaryLength === 'short'
  ? `- Distill the document to its essence: a tight overview, the core concepts with crisp definitions, the key formulas (LaTeX, variables explained), and the main practical points.
- End with a "key takeaways" list of 5-7 bullets and a short glossary of the most important terms.`
  : `- Include: an introduction covering purpose, theoretical context and practical relevance; every fundamental concept, bolded and rigorously defined, including how concepts interrelate; a fully developed section for each chapter/topic of the document - operating principles, ${summaryLength === 'academic' ? 'derivations where the document shows them, ' : ''}advantages and limitations, applications, and concrete numeric values or standards the document mentions; ALL formulas and relations, each displayed in LaTeX with every variable explained; comparison tables wherever the document contrasts types, methods or approaches.
- End with: a "key takeaways" list; an alphabetical glossary of the important technical terms; and a final "## Self-assessment" section with ${summaryLength === 'academic' ? '6-8' : '4-6'} exam-style open questions about this material (questions only, no answers).`}

Maximum length: ${wordLimit}.`
    };

    // Generate sections based on subscription tier - single API call
    let summaryContent = '';

    for (const sectionType of config.sections) {
      if (sectionPrompts[sectionType]) {
        try {
          // Get adaptive section content based on document type
          let chunkPrompt = sectionPrompts[sectionType].replace(/\[TEXT\]/g, truncatedText);

          // Replace placeholders for dynamic sections
          if (sectionType === 'basic') {
            const adaptiveSection = getAdaptiveSectionContent('basic', technicalContent.hasMeaningfulFormulas);
            chunkPrompt = chunkPrompt
              .replace('[SECTION_3_TITLE]', adaptiveSection.title)
              .replace('[SECTION_3_CONTENT]', adaptiveSection.content)
              .replace('[SECTION_3_QUESTION]', adaptiveSection.question);
          } else if (sectionType === 'trial') {
            const adaptiveSection = getAdaptiveSectionContent('trial', technicalContent.hasMeaningfulFormulas);
            chunkPrompt = chunkPrompt
              .replace('[SECTION_3_TITLE]', adaptiveSection.title)
              .replace('[SECTION_3_CONTENT]', adaptiveSection.content);
          } else if (sectionType === 'standard') {
            const adaptiveSection = getAdaptiveSectionContent('standard', technicalContent.hasMeaningfulFormulas);
            chunkPrompt = chunkPrompt
              .replace('[SECTION_4_TITLE]', adaptiveSection.title)
              .replace('[SECTION_4_CONTENT]', adaptiveSection.content);
          }

          const systemMessage =
            `You are an expert tutor and technical writer who produces exceptional study summaries. ` +
            `You write in ${targetLanguage}, use clean Markdown, and typeset ALL mathematics in LaTeX ` +
            `between $ (inline) or $$ (display) delimiters - never as plain text or code spans. ` +
            `You output only the summary itself: no preamble, no placeholders, no meta-commentary.`;

          // Fallback chain: primary OpenAI model -> secondary OpenAI model -> Claude
          const sectionCompletion = await createChatCompletion({
            model: summaryModel,
            system: systemMessage,
            prompt: chunkPrompt,
            maxTokens: Math.floor(maxTokens * 0.85), // Use 85% of available tokens for response
            temperature,
          });

          if (sectionCompletion.content) {
            summaryContent = sectionCompletion.content;
            console.log(`Summary generated by ${sectionCompletion.provider}/${sectionCompletion.model}`);
          }

        } catch (error) {
          console.error(`Eroare generare secțiune ${sectionType}:`, error);
        }
      }
    }

    summaryContent = improveFormatting(summaryContent);

    // Clean unwanted promotional content and limitations from summary
    function cleanSummaryContent(content: string): string {
      let cleaned = content;

      // Remove limitation sections
      cleaned = cleaned.replace(/\*\*LIMITĂRI [A-Z]+:\*\*[\s\S]*?(?=\*\*[A-Z]|\n###|\n##|$)/g, '');

      // Remove upgrade prompts
      cleaned = cleaned.replace(/\*\*UPGRADE.*?[\s\S]*?(?=\*\*[A-Z]|\n###|\n##|$)/g, '');

      // Remove requirement sections at the end
      cleaned = cleaned.replace(/\*\*CERINȚE[:\s]*\*\*[\s\S]*?(?=\n###|\n##|$)/g, '');

      // Remove any promotional text about Premium
      cleaned = cleaned.replace(/\*Pentru.*?vezi planul Premium\*/g, '');

      // Remove empty sections that might be left
      cleaned = cleaned.replace(/###\s*\*\*[^*]*\*\*\s*\n\s*(?=###|##|$)/g, '');

      // Clean multiple newlines
      cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

      return cleaned.trim();
    }

    summaryContent = cleanSummaryContent(summaryContent);

    let quiz: QuizQuestion[] = [];

    // Generate quiz based on subscription tier (skip only for free users)
    const skipQuiz = user.subscription === 'free';

    console.log(`Quiz generation check - User: ${user.subscription}, maxQuestions: ${config.maxQuestions}, skipQuiz: ${skipQuiz}`);

    // Generate quiz based on subscription tier (only if not skipping)
    if (config.maxQuestions > 0 && !skipQuiz) {
      const numQuestions = config.maxQuestions;
      const quizModel = config.model;
      const quizMaxTokens = Math.floor(config.maxTokens * 0.5);

      // Enhanced quiz generation based on subscription tier with language support
      const quizComplexityTranslations: Record<string, { trial: string; standard: string; premium: string }> = {
        en: {
          trial: 'Simple conceptual understanding questions',
          standard: 'Medium questions with practical applications',
          premium: 'Complex questions with calculations and comparative analyses'
        },
        ro: {
          trial: 'Întrebări simple de înțelegere conceptuală',
          standard: 'Întrebări medii cu aplicații practice',
          premium: 'Întrebări complexe cu calcule și analize comparative'
        },
        fr: {
          trial: 'Questions simples de compréhension conceptuelle',
          standard: 'Questions moyennes avec applications pratiques',
          premium: 'Questions complexes avec calculs et analyses comparatives'
        },
        de: {
          trial: 'Einfache konzeptionelle Verständnisfragen',
          standard: 'Mittlere Fragen mit praktischen Anwendungen',
          premium: 'Komplexe Fragen mit Berechnungen und vergleichenden Analysen'
        },
        es: {
          trial: 'Preguntas simples de comprensión conceptual',
          standard: 'Preguntas medias con aplicaciones prácticas',
          premium: 'Preguntas complejas con cálculos y análisis comparativos'
        }
      };

      const quizComplexity = quizComplexityTranslations[documentLanguage] || quizComplexityTranslations.en;

      // Multi-language quiz prompts
      // For detailed/long summaries, use more content or a better sample that includes technical details
      const getSummaryExcerpt = (content: string, maxLength: number = 2500): string => {
        if (content.length <= maxLength) return content;

        // For longer summaries, try to get a sample that includes technical content
        // Start after the table of contents but include technical sections
        const tocEnd = content.indexOf('### **1.') || content.indexOf('###') || 0;
        const startPos = Math.min(tocEnd, Math.floor(content.length * 0.1));

        // Take a larger sample from the middle sections for better context
        const sampleLength = Math.min(maxLength * 2, content.length - startPos);
        return content.substring(startPos, startPos + sampleLength);
      };

      const summaryExcerpt = getSummaryExcerpt(summaryContent, user.subscription === 'premium' ? 4000 : 2500);

      console.log(`Summary length: ${summaryContent.length}, Excerpt length: ${summaryExcerpt.length}, Summary type: ${summaryLength}`);

      const quizPromptTemplates: Record<string, string> = {
        en: `
Create EXACTLY ${numQuestions} evaluation questions for this technical material (in ${targetLanguage}):

${summaryExcerpt}

Level: ${quizComplexity[user.subscription as keyof typeof quizComplexity] || quizComplexity.trial}

${user.subscription === 'premium' ? `
QUESTION DISTRIBUTION (${numQuestions} total):
- 35% Numerical calculations with concrete formulas from text: ${technicalContent.formulas.slice(0, 4).join(', ')}
- 25% Practical applications and real case studies
- 20% Detailed comparisons between methods/technologies
- 15% Fundamental theoretical principles
- 5% Interpretation of graphs/diagrams from text

PREMIUM SPECIAL REQUIREMENTS:
- Each question should have detailed explanations of at least 2 sentences
- Should include calculations with concrete numerical values from text
- Should test deep understanding, not memorization
- Should have 4 realistic answer options
` : user.subscription === 'standard' ? `
QUESTION DISTRIBUTION (${numQuestions} total):
- 50% Application of concepts in practice
- 30% Understanding basic formulas
- 20% Identifying advantages/disadvantages
` : `
QUESTION DISTRIBUTION (${numQuestions} total):
- 70% Understanding basic concepts
- 30% Identifying technical terms
`}

IMPORTANT: Return EXACTLY ${numQuestions} questions. No fewer!

JSON Format:
{
  "questions": [
    {
      "question": "complete question with context",
      "options": ["A) complete option", "B) complete option", "C) complete option", "D) complete option"],
      "correctAnswer": 0,
      "explanation": "detailed explanation of at least 2 sentences"
    }
  ]
}
`,
        ro: `
Creează EXACT ${numQuestions} întrebări de evaluare pentru acest material tehnic (în ${targetLanguage}):

${summaryExcerpt}

Nivel: ${quizComplexity[user.subscription as keyof typeof quizComplexity] || quizComplexity.trial}

${user.subscription === 'premium' ? `
DISTRIBUȚIE ÎNTREBĂRI (${numQuestions} total):
- 35% Calcule numerice cu formule concrete din text: ${technicalContent.formulas.slice(0, 4).join(', ')}
- 25% Aplicații practice și studii de caz reale
- 20% Comparații detaliate între metode/tehnologii
- 15% Principii teoretice fundamentale
- 5% Interpretarea graficelor/diagramelor din text

CERINȚE SPECIALE PREMIUM:
- Fiecare întrebare să aibă explicații detaliate de minimum 2 propoziții
- Să includă calcule cu valori numerice concrete din text
- Să testeze înțelegerea profundă, nu memorarea
- Să aibă 4 opțiuni realiste de răspuns
` : user.subscription === 'standard' ? `
DISTRIBUȚIE ÎNTREBĂRI (${numQuestions} total):
- 50% Aplicarea conceptelor în practică
- 30% Înțelegerea formulelor de bază
- 20% Identificarea avantajelor/dezavantajelor
` : `
DISTRIBUȚIE ÎNTREBĂRI (${numQuestions} total):
- 70% Înțelegerea conceptelor de bază
- 30% Identificarea termenilor tehnici
`}

IMPORTANT: Returnează EXACT ${numQuestions} întrebări. Nu mai puține!

Format JSON:
{
  "questions": [
    {
      "question": "întrebarea completă cu context",
      "options": ["A) opțiunea completă", "B) opțiunea completă", "C) opțiunea completă", "D) opțiunea completă"],
      "correctAnswer": 0,
      "explanation": "explicație detaliată de minimum 2 propoziții"
    }
  ]
}
`
      };

      const quizPrompt = quizPromptTemplates[documentLanguage] || quizPromptTemplates.en;

      // Check if model supports JSON mode, fallback to text parsing
      const supportsJsonMode = (quizModel.includes('gpt-4-turbo') || quizModel.includes('gpt-3.5-turbo-1106') || quizModel.includes('gpt-3.5-turbo-0125') || quizModel.includes('gpt-4o-mini')) && !quizModel.includes('o1');
      
      // Multi-language system messages
      const systemMessageTemplates: Record<string, string> = {
        en: `You are an expert professor who creates high-quality multiple-choice tests. You must generate EXACTLY ${numQuestions} relevant and challenging questions. Use the language: ${targetLanguage}.${!supportsJsonMode ? ' Respond strictly in valid JSON format.' : ''}`,
        ro: `Ești un profesor expert care creează teste grilă de înaltă calitate. Trebuie să generezi EXACT ${numQuestions} întrebări relevante și provocatoare. Folosește limba: ${targetLanguage}.${!supportsJsonMode ? ' Răspunde strict în format JSON valid.' : ''}`,
        fr: `Vous êtes un professeur expert qui crée des tests à choix multiples de haute qualité. Vous devez générer EXACTEMENT ${numQuestions} questions pertinentes et stimulantes. Utilisez la langue: ${targetLanguage}.${!supportsJsonMode ? ' Répondez strictement au format JSON valide.' : ''}`,
        de: `Sie sind ein Experten-Professor, der hochwertige Multiple-Choice-Tests erstellt. Sie müssen GENAU ${numQuestions} relevante und herausfordernde Fragen generieren. Verwenden Sie die Sprache: ${targetLanguage}.${!supportsJsonMode ? ' Antworten Sie strikt im gültigen JSON-Format.' : ''}`,
        es: `Eres un profesor experto que crea pruebas de opción múltiple de alta calidad. Debes generar EXACTAMENTE ${numQuestions} preguntas relevantes y desafiantes. Usa el idioma: ${targetLanguage}.${!supportsJsonMode ? ' Responde estrictamente en formato JSON válido.' : ''}`
      };

      const systemMessage = systemMessageTemplates[documentLanguage] || systemMessageTemplates.en;

      try {
        console.log(`Attempting quiz generation for ${user.subscription} user with ${numQuestions} questions`);
        // Same fallback chain as the summary; jsonMode adds response_format
        // on OpenAI models that support it and a strict-JSON instruction otherwise.
        const quizCompletion = await createChatCompletion({
          model: quizModel,
          system: systemMessage,
          prompt: quizPrompt,
          maxTokens: quizMaxTokens,
          temperature: 0.5,
          jsonMode: true,
        });

        const rawContent = quizCompletion.content || '{}';
        console.log(`Quiz API response received, length: ${rawContent.length}`);

        // Try to extract JSON if it's wrapped in markdown code blocks
        let jsonContent = rawContent;
        if (rawContent.includes('```json')) {
          const match = rawContent.match(/```json\s*([\s\S]*?)\s*```/);
          if (match) {
            jsonContent = match[1].trim();
          }
        } else if (rawContent.includes('```')) {
          const match = rawContent.match(/```\s*([\s\S]*?)\s*```/);
          if (match) {
            jsonContent = match[1].trim();
          }
        }

        // Try to fix common JSON issues
        jsonContent = jsonContent
          .replace(/,(\s*[}\]])/g, '$1') // Remove trailing commas
          .replace(/\n/g, ' ') // Remove newlines that might break strings
          .replace(/\r/g, ''); // Remove carriage returns

        const quizJson = JSON.parse(jsonContent);
        quiz = quizJson.questions || [];

        console.log(`Quiz parsed successfully, ${quiz.length} questions generated`);

        // Validate quiz has the right structure
        if (!Array.isArray(quiz) || quiz.length === 0) {
          console.warn('Quiz generated but has no questions');
          quiz = [];
        }
      } catch (error) {
        console.error('Eroare generare/parsare quiz:', error);
        console.error('Error message:', getErrorMessage(error));
        // Set empty quiz array on error
        quiz = [];
      }
    } else {
      console.log(`Quiz generation skipped - maxQuestions: ${config.maxQuestions}, skipQuiz: ${skipQuiz}`);
    }

    // Cache the result for future use (after quiz generation)
    await cacheSet(summaryCacheKey, { summary: summaryContent, quiz } satisfies CachedSummary, CACHE_TTL_SECONDS);

    // Parallel database operations for better performance
    const titlePrefixes: Record<string, string> = {
      en: 'Summary',
      ro: 'Rezumat',
      fr: 'Résumé',
      de: 'Zusammenfassung',
      es: 'Resumen',
      it: 'Riassunto'
    };
    
    const titlePrefix = titlePrefixes[documentLanguage] || 'Summary';
    const summaryTitle = `${titlePrefix} ${filename.substring(0, 30)}`;

    // File first so the Summary can link to it (fileId powers the learning workspace)
    const [, fileRecord] = await Promise.all([
      prisma.usage.create({
        data: {
          userId: user.id
        }
      }),
      prisma.file.create({
        data: {
          userId: user.id,
          name: filename,
          size: fileSize,
          pages: numpages,
          characters: text.length,
          summary: summaryContent,
          quiz: quiz as unknown as Prisma.InputJsonValue,
          language: documentLanguage,
          extractedText: text.slice(0, 1_500_000),
          contentHash
        }
      })
    ]);
    const summaryRecord = await prisma.summary.create({
      data: {
        title: summaryTitle,
        content: summaryContent,
        language: documentLanguage,
        userId: user.id,
        fileId: fileRecord.id,
      }
    });
    // Tells the user their summary landed in the Library even if they
    // navigated away while it was processing.
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'summary_ready',
        payload: { title: summaryRecord.title },
        href: `/workspace/${summaryRecord.id}`,
      },
    }).catch((e) => console.error('[summarize] notification create failed:', e));

    // Diagram pages render AFTER the response is sent - they must never
    // slow down or break the summary flow.
    after(() => generateDiagramsArtifact(summaryRecord.id, user.id, buffer, pageTexts));

    return new Response(
      JSON.stringify({
        summary: summaryContent,
        quiz,
        fileID: fileRecord.id,
        summaryId: summaryRecord.id,
        meta: {
          filename,
          pages: numpages,
          size: fileSize,
          characters: text.length,
          language: targetLanguage
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    
  } catch (err) {
    console.error('Eroare procesare PDF:', err);
    const error = err as { message?: string; name?: string; code?: string; status?: number };

    let errorMessage = 'Eroare internă la procesarea documentului';
    let status = 500;

    if (error.message?.includes('Unexpected token')) {
      errorMessage = 'Format PDF neacceptat. Încercați cu un alt fișier.';
      status = 400;
    } else if (error.name === 'AbortError' || error.code === 'ECONNABORTED') {
      errorMessage = 'Timp de procesare depășit. Încercați cu un fișier mai mic.';
      status = 408;
    } else if (error.status === 429) {
      errorMessage = 'Prea multe solicitări. Vă rugăm să așteptați un minut.';
      status = 429;
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Conexiune la server eșuată. Verificați internetul.';
      status = 503;
    } else if (error.message?.includes('limita lunară')) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status, headers: { 'Content-Type': 'application/json' } }
    );
  }
}