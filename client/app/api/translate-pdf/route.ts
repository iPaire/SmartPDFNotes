// app/api/translate-pdf/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument, rgb, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import pdf from 'pdf-parse';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';
import { checkContentLength, checkFileSize, sniffType } from '@/lib/upload-guard';

// Google Translate target codes the UI offers. Whitelisted so the parameter
// can't be abused to smuggle arbitrary query content into the upstream call.
const SUPPORTED_TARGET_LANGS = new Set([
  'en', 'ro', 'es', 'de', 'fr', 'it', 'pt', 'nl', 'pl', 'hu', 'cs', 'sk',
  'bg', 'el', 'tr', 'ru', 'uk', 'sv', 'no', 'da', 'fi', 'ar', 'he', 'hi',
  'id', 'vi', 'th', 'zh-CN', 'ja', 'ko',
]);

export async function POST(request: NextRequest) {
  try {
    // Per-IP rate limit - this route is unauthenticated and CPU/network heavy
    const rateLimit = await checkRateLimit('convert', getClientIp(request));
    if (!rateLimit.success) {
      return rateLimitResponse(rateLimit);
    }

    // Reject oversized requests before buffering the body into memory
    const lengthCheck = checkContentLength(request);
    if (!lengthCheck.ok) {
      return NextResponse.json({ error: lengthCheck.error }, { status: 413 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const targetLangRaw = formData.get('targetLang');
    const targetLang =
      typeof targetLangRaw === 'string' && SUPPORTED_TARGET_LANGS.has(targetLangRaw)
        ? targetLangRaw
        : 'en';

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Convert file to buffer
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    // Enforce the per-file size cap
    const sizeCheck = checkFileSize(fileBuffer.length);
    if (!sizeCheck.ok) {
      return NextResponse.json({ error: sizeCheck.error }, { status: 413 });
    }

    // Validate the real file type by magic bytes, not the spoofable file.type.
    if (sniffType(fileBuffer) !== 'pdf') {
      return NextResponse.json({ error: 'Only valid PDF files are allowed' }, { status: 400 });
    }

    // Load original PDF to preserve structure
    const originalPdf = await PDFDocument.load(fileBuffer);

    // Extract text from PDF
    const pdfData = await pdf(fileBuffer);
    const originalText = pdfData.text;

    if (!originalText || originalText.trim().length === 0) {
      return NextResponse.json({
        error: 'Could not extract text from PDF. The PDF might be empty or contain only images.'
      }, { status: 400 });
    }

    // Clean text - remove binary/image data
    const cleanedText = cleanTextFromBinary(originalText);

    if (!cleanedText || cleanedText.trim().length === 0) {
      return NextResponse.json({
        error: 'Could not extract readable text from PDF after filtering.'
      }, { status: 400 });
    }

    // Translate text to the requested language, preserving structure
    const translatedText = await translateTextPreservingStructure(cleanedText, targetLang);

    // Create new PDF with translated text AND original images/diagrams
    const translatedPdfBytes = await createPdfWithTextAndImages(translatedText, file.name, originalPdf);

    // Return the translated PDF
    return new NextResponse(Buffer.from(translatedPdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(
          file.name.replace('.pdf', `_translated_${targetLang}.pdf`)
        )}"`,
      },
    });
  } catch (error) {
    console.error('Translation error:', error);
    return NextResponse.json(
      { error: 'Translation failed. Please try again.' },
      { status: 500 }
    );
  }
}

// Function to clean text from binary/image data
function cleanTextFromBinary(text: string): string {
  // Remove non-printable characters except newlines, tabs, and spaces
  // This filters out binary data from images while keeping text structure
  let cleaned = text.replace(/[^\x20-\x7E\xA0-\uFFFF\n\r\t]/g, '');

  // Remove sequences of random characters that look like binary (e.g., long sequences without spaces)
  // Typically image data appears as long strings of random characters
  cleaned = cleaned.replace(/[^\s]{200,}/g, '');

  // Remove common image format markers and metadata
  cleaned = cleaned.replace(/\b(JFIF|Exif|PNG|IHDR|IDAT|IEND|GIF89a|BMP)\b/g, '');

  // Remove base64-like strings (common in embedded images)
  cleaned = cleaned.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, '');

  // Remove hexadecimal sequences (image metadata)
  cleaned = cleaned.replace(/([0-9A-Fa-f]{2}\s*){20,}/g, '');

  // Remove lines that are mostly non-alphabetic (likely image metadata)
  const lines = cleaned.split('\n');
  const filteredLines = lines.filter(line => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true; // Keep empty lines for structure

    // Count alphabetic characters
    const alphaCount = (trimmed.match(/[a-zA-Z]/g) || []).length;
    const totalCount = trimmed.length;

    // Keep line if at least 30% is alphabetic characters, or if it's very short
    return totalCount < 10 || (alphaCount / totalCount) > 0.3;
  });

  return filteredLines.join('\n');
}

// Function to merge broken mathematical expressions across lines
function mergeBrokenMath(text: string): string {
  const lines = text.split('\n');
  const mergedLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check if this line is a single math symbol or very short math fragment
    const isMathFragment = /^[√∑∏∫∂∞±×÷≤≥≠≈α-ωΑ-Ωπ0-9\s\-+*/^=()]+$/.test(trimmed) && trimmed.length <= 10;

    if (isMathFragment && i > 0) {
      // Try to merge with previous line if it's also mathematical
      const prevLine = mergedLines[mergedLines.length - 1];
      if (prevLine && /[√∑∏∫α-ωΑ-Ωπ0-9=+\-*/^()]/.test(prevLine)) {
        mergedLines[mergedLines.length - 1] = prevLine + ' ' + trimmed;
        i++;
        continue;
      }
    }

    // Check for common pattern: operator or function name on its own line
    const isMathOperator = /^(sin|cos|tan|log|ln|exp|sqrt|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|[+\-*/^=])$/i.test(trimmed);

    if (isMathOperator && i > 0) {
      // Merge with previous line
      const prevLine = mergedLines[mergedLines.length - 1];
      if (prevLine) {
        mergedLines[mergedLines.length - 1] = prevLine + ' ' + trimmed;
        i++;
        continue;
      }
    }

    // Check if this line starts with a number followed by a math function (e.g., "2 cos", "3 sin")
    const startsWithNumberAndFunc = /^\d+\s*(sin|cos|tan|log|ln|exp|sqrt|sec|csc|cot)/i.test(trimmed);

    // Check if previous line ends with a number or math symbol
    const prevEndsWithMath = i > 0 && mergedLines.length > 0 && /[√∑∏∫α-ωΑ-Ωπ0-9=+\-*/^()]\s*$/.test(mergedLines[mergedLines.length - 1]);

    if (startsWithNumberAndFunc && prevEndsWithMath) {
      // Merge with previous line
      mergedLines[mergedLines.length - 1] = mergedLines[mergedLines.length - 1] + ' ' + trimmed;
      i++;
      continue;
    }

    mergedLines.push(line);
    i++;
  }

  return mergedLines.join('\n');
}

// Function to extract and preserve mathematical formulas and image references
function extractMathFormulas(text: string): { text: string, formulas: Map<string, string> } {
  const formulas = new Map<string, string>();

  // First, try to merge broken mathematical expressions
  let processedText = mergeBrokenMath(text);

  let counter = 0;

  // Preserve image and figure references (e.g., "Figure 1", "Fig. 2", "Image 3", "Diagram 4", "Figura 1")
  processedText = processedText.replace(/\b(Figure|Fig\.|Image|Diagram|Chart|Graph|Table|Equation|Eq\.|Formula|Figura|Tabel|Grafic|Ecuația)\s+\d+(\.\d+)?([a-z])?\b/gi, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve mathematical expressions in parentheses with subscripts: (R), (RL), (R-L)
  processedText = processedText.replace(/\([A-Z][A-Z\-\d]*\)/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve LaTeX display math: $$...$$ or \[...\]
  processedText = processedText.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve LaTeX inline math: $...$ or \(...\)
  processedText = processedText.replace(/\$[^\$\n]+?\$|\\\([^\)]+?\\\)/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve entire lines that are primarily mathematical (contain high density of math symbols)
  // This catches multi-line formulas and complex expressions
  const lines = processedText.split('\n');
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Count mathematical characters vs total characters
    const mathChars = (trimmed.match(/[√∑∏∫∂∞±×÷≤≥≠≈∈∉⊂⊃∪∩α-ωΑ-Ωπ=+\-*/^()<>[\]{}0-9]/g) || []).length;
    const totalChars = trimmed.length;

    // If line is >50% mathematical characters, preserve it entirely
    if (mathChars / totalChars > 0.5) {
      const placeholder = `__MATH_FORMULA_${counter}__`;
      formulas.set(placeholder, trimmed);
      counter++;
      return line.replace(trimmed, placeholder);
    }
    return line;
  });
  processedText = processedLines.join('\n');

  // Preserve complex multi-symbol mathematical expressions FIRST (most specific pattern)
  // This matches expressions like: 2√2sin(π/6), cos(5π/6), etc.
  processedText = processedText.replace(/\d*[√α-ωΑ-Ωπ]?[\dα-ωΑ-Ωπ]*\s*(sin|cos|tan|log|ln|exp|sqrt|sec|csc|cot)\s*[\(]?[^\s\n]{1,30}[\)]?/gi, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve number + space + function patterns (e.g., "2 cos", "3 sin")
  processedText = processedText.replace(/\b\d+\s+(sin|cos|tan|sec|csc|cot|log|ln|exp|sqrt|sinh|cosh|tanh)\b/gi, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve standalone trigonometric and mathematical function names LAST (most general)
  // Matches: sin, cos, tan, log, etc. when they appear alone
  processedText = processedText.replace(/\b(sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|log|ln|exp|sqrt|sinh|cosh|tanh)\b/gi, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve fractions and complex expressions with multiple components
  // Examples: π/6, 5π/6, 2√2/3, (a+b)/c
  processedText = processedText.replace(/[\(]?[\dα-ωΑ-Ωπ√a-zA-Z]+[\+\-]?[\dα-ωΑ-Ωπ√a-zA-Z]*[\)]?\s*\/\s*[\(]?[\dα-ωΑ-Ωπ√a-zA-Z]+[\)]?/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve expressions with square roots and their coefficients
  // Examples: √2, 2√2, 3√2, √2U2, etc.
  processedText = processedText.replace(/\d*√\d*[\dα-ωΑ-Ωa-zA-Z]*/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve ALL variables with subscripts: u21, u22, u23, i21, iD1, iD2, etc.
  // This is more aggressive to catch all mathematical variables
  processedText = processedText.replace(/\b[a-zA-Zα-ωΑ-Ω][a-zA-Z]*\d+[a-zA-Z\d]*\b/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve common variable names: Usmed, Ismed, PAC, PDC, etc.
  processedText = processedText.replace(/\b[UI][a-zA-Z]*med[a-z]?\b|\bP(AC|DC)\b|\b[DRL][\d]+\b/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve complex parenthetical expressions like (R), (RL), (R-L)
  processedText = processedText.replace(/\([A-Z][A-Z\-]*\)/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  // Preserve standalone Greek letters and mathematical symbols
  processedText = processedText.replace(/\b[α-ωΑ-Ωπω]+\b/g, (match) => {
    const placeholder = `__MATH_FORMULA_${counter}__`;
    formulas.set(placeholder, match);
    counter++;
    return placeholder;
  });

  return { text: processedText, formulas };
}

// Function to normalize modified placeholders after translation
function normalizePlaceholders(text: string): string {
  // Google Translate often adds spaces or modifies placeholders
  // Normalize common variations back to the original format

  // Pattern to match modified placeholders with extra spaces or translations
  // Matches: __ MATH_FORMULA_8 __, __MATH_FORMULA_8__, __ MATH _ FORMULA _ 8 __, etc.
  const placeholderPattern = /_+\s*(?:MATH|math|Math|FÓRMULA|formula)\s*_+\s*(?:FORMULA|formula|Formula|FÓRMULA|fórmula)\s*_+\s*(\d+)\s*_+/gi;

  // Normalize to standard format: __MATH_FORMULA_N__
  text = text.replace(placeholderPattern, (match, number) => {
    return `__MATH_FORMULA_${number}__`;
  });

  return text;
}

// Function to restore mathematical formulas
function restoreMathFormulas(text: string, formulas: Map<string, string>): string {
  // First, normalize any modified placeholders
  let restoredText = normalizePlaceholders(text);

  // Then restore all formulas
  formulas.forEach((formula, placeholder) => {
    // Use global replacement to restore all occurrences
    restoredText = restoredText.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), formula);
  });

  return restoredText;
}

// Function to translate text while preserving structure (newlines, spacing), math formulas, and image references
async function translateTextPreservingStructure(text: string, targetLang: string): Promise<string> {
  try {
    // Extract and preserve mathematical formulas and image references
    const { text: textWithoutMath, formulas } = extractMathFormulas(text);

    // Debug: Log extracted formulas
    console.log(`Extracted ${formulas.size} mathematical formulas/expressions`);
    if (formulas.size > 0) {
      console.log('Sample formulas:', Array.from(formulas.entries()).slice(0, 10));
    }

    // Split by double newlines to preserve paragraph structure
    const paragraphs = textWithoutMath.split(/\n\n+/);
    const translatedParagraphs: string[] = [];

    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) {
        translatedParagraphs.push('');
        continue;
      }

      // Translate paragraph in chunks if needed
      const chunkSize = 4000;
      if (paragraph.length <= chunkSize) {
        const translated = await translateChunk(paragraph, targetLang);
        translatedParagraphs.push(translated);
      } else {
        // Split long paragraphs by sentences
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        let currentChunk = '';
        const chunks: string[] = [];

        for (const sentence of sentences) {
          if ((currentChunk + sentence).length > chunkSize) {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
        if (currentChunk) chunks.push(currentChunk);

        const translatedChunks: string[] = [];
        for (const chunk of chunks) {
          const translated = await translateChunk(chunk, targetLang);
          translatedChunks.push(translated);
        }
        translatedParagraphs.push(translatedChunks.join(' '));
      }
    }

    // Rejoin with double newlines to maintain paragraph separation
    const translatedText = translatedParagraphs.join('\n\n');

    // Debug: Check if placeholders still exist in translated text
    const placeholderMatches = translatedText.match(/__MATH_FORMULA_\d+__/g);
    console.log(`Found ${placeholderMatches ? placeholderMatches.length : 0} exact placeholders in translated text`);

    // Check for modified placeholders
    const modifiedPlaceholders = translatedText.match(/_+\s*(?:MATH|math|FÓRMULA|formula).*?\d+.*?_+/gi);
    console.log(`Found ${modifiedPlaceholders ? modifiedPlaceholders.length : 0} potentially modified placeholders`);

    // Restore mathematical formulas
    const restoredText = restoreMathFormulas(translatedText, formulas);

    // Debug: Check if restoration worked
    const remainingPlaceholders = restoredText.match(/__MATH_FORMULA_\d+__/g);
    console.log(`Remaining placeholders after restoration: ${remainingPlaceholders ? remainingPlaceholders.length : 0}`);

    return restoredText;
  } catch (error) {
    console.error('Translation error:', error);
    throw new Error('Failed to translate text');
  }
}

// Helper function to translate a single chunk
async function translateChunk(chunk: string, targetLang: string): Promise<string> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(chunk)}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error('Translation service unavailable');
  }

  const data = await response.json();

  // Extract translated text from response
  const translated = data[0]
    .map((item: string[]) => item[0])
    .join('');

  return translated;
}

// Function to load Unicode font
async function getUnicodeFont(pdfDoc: PDFDocument) {
  try {
    const fontPath = join(process.cwd(), 'public', 'fonts', 'Roboto-Regular.ttf');
    const fontBytes = readFileSync(fontPath);
    return await pdfDoc.embedFont(fontBytes);
  } catch (error) {
    console.error('Could not load Roboto font:', error);
    throw new Error('Font loading failed');
  }
}

// Function to create PDF with translated text AND preserve images from original
async function createPdfWithTextAndImages(
  text: string,
  originalFileName: string,
  originalPdf: PDFDocument
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const font = await getUnicodeFont(pdfDoc);

  const fontSize = 10; // Smaller font to fit more content
  const lineHeight = fontSize * 1.4;
  const margin = 40;
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const maxWidth = pageWidth - (margin * 2);

  // Split text into paragraphs - preserve structure better
  const paragraphs = text.split(/\n\n+/);
  const allLines: string[] = [];

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();

    // Skip empty paragraphs but preserve spacing
    if (!trimmedParagraph) {
      allLines.push('');
      continue;
    }

    // Check if paragraph has newlines (preserve line breaks within paragraphs)
    const paragraphLines = trimmedParagraph.split('\n');

    for (const line of paragraphLines) {
      if (!line.trim()) {
        allLines.push('');
        continue;
      }

      const words = line.trim().split(/\s+/);
      const wrappedLines: string[] = [];
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        const textWidth = font.widthOfTextAtSize(testLine, fontSize);

        if (textWidth <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) {
            wrappedLines.push(currentLine);
            currentLine = word;
          } else {
            // Word is too long, break it
            const maxChars = Math.floor(maxWidth / (fontSize * 0.5));
            wrappedLines.push(word.substring(0, maxChars));
            currentLine = word.substring(maxChars);
          }
        }
      }

      if (currentLine) {
        wrappedLines.push(currentLine);
      }

      allLines.push(...wrappedLines);
    }

    // Add spacing between paragraphs (but not after the last one)
    const currentParagraphIndex = paragraphs.indexOf(paragraph);
    if (currentParagraphIndex < paragraphs.length - 1) {
      allLines.push('');
    }
  }

  // Try to copy pages from original PDF to preserve images and diagrams
  try {
    const pageCount = originalPdf.getPageCount();
    console.log(`Original PDF has ${pageCount} pages`);

    // Copy all pages from original PDF
    const copiedPages = await pdfDoc.copyPages(originalPdf, originalPdf.getPageIndices());

    // Add each copied page to the new document
    for (const copiedPage of copiedPages) {
      pdfDoc.addPage(copiedPage);
    }

    console.log(`Copied ${copiedPages.length} pages with images preserved`);
  } catch (error) {
    console.error('Could not copy original pages:', error);
  }

  // Add translated text pages at the beginning
  const linesPerPage = Math.floor((pageHeight - 100) / lineHeight);
  const totalTextPages = Math.ceil(allLines.length / linesPerPage);

  for (let pageIndex = 0; pageIndex < totalTextPages; pageIndex++) {
    const page = pdfDoc.insertPage(pageIndex, [pageWidth, pageHeight]);

    // Add header on first page
    if (pageIndex === 0) {
      page.drawText(`Translation: ${originalFileName}`, {
        x: margin,
        y: pageHeight - margin,
        size: fontSize + 4,
        font,
        color: rgb(0, 0, 0.8),
      });

      page.drawRectangle({
        x: margin,
        y: pageHeight - margin - 25,
        width: maxWidth,
        height: 1,
        color: rgb(0.7, 0.7, 0.7),
      });

      page.drawText('(Original pages with diagrams follow)', {
        x: margin,
        y: pageHeight - margin - 40,
        size: fontSize,
        font,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    const startY = pageIndex === 0 ? pageHeight - margin - 60 : pageHeight - margin - 20;

    const startLine = pageIndex * linesPerPage;
    const endLine = Math.min(startLine + linesPerPage, allLines.length);

    for (let i = startLine; i < endLine; i++) {
      const line = allLines[i];
      if (line.trim() || i === startLine) {
        page.drawText(line, {
          x: margin,
          y: startY - ((i - startLine) * lineHeight),
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    if (totalTextPages > 1) {
      page.drawText(`Translation Page ${pageIndex + 1} of ${totalTextPages}`, {
        x: pageWidth - margin - 120,
        y: 30,
        size: fontSize - 2,
        font,
        color: rgb(0.5, 0.5, 0.5),
      });
    }
  }

  return await pdfDoc.save();
}
