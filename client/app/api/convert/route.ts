// app/api/convert/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit';
import {
  checkContentLength,
  checkFileSize,
  sniffType,
  looksLikeText,
  MAX_UPLOAD_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
} from '@/lib/upload-guard';

export const maxDuration = 60;

type SupportedType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'text/plain';

/** Resolve a validated, supported type or null. Magic bytes for binaries, an
 *  extension + content check for text. */
function resolveType(buffer: Buffer, name: string): SupportedType | null {
  const sniffed = sniffType(buffer);
  if (sniffed === 'pdf') return 'application/pdf';
  if (sniffed === 'jpeg') return 'image/jpeg';
  if (sniffed === 'png') return 'image/png';
  if (looksLikeText(buffer, name)) return 'text/plain';
  return null;
}

export async function POST(request: NextRequest) {
  try {
    // Per-IP rate limit - this route is unauthenticated and CPU heavy
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
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    // Phase 1: read each file once and enforce the size caps.
    const items: { name: string; buffer: Buffer }[] = [];
    const tooLarge: string[] = [];
    let totalBytes = 0;
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!checkFileSize(buffer.length).ok) {
        tooLarge.push(file.name);
        continue;
      }
      totalBytes += buffer.length;
      items.push({ name: file.name, buffer });
    }

    const perFileMb = Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024);
    if (tooLarge.length > 0) {
      return NextResponse.json(
        {
          error: `Some files exceed the ${perFileMb}MB per-file limit.`,
          failedFiles: tooLarge.map((name) => ({ name, reason: `Exceeds the ${perFileMb}MB per-file limit.` })),
        },
        { status: 413 }
      );
    }
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `Total upload exceeds the ${Math.floor(MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024)}MB limit.` },
        { status: 413 }
      );
    }

    // Phase 2: validate types up front. Reject the whole batch if any file is
    // unsupported - no misleading "success" PDF with placeholder pages.
    const prepared: { name: string; buffer: Buffer; type: SupportedType }[] = [];
    const unsupported: { name: string; reason: string }[] = [];
    for (const { name, buffer } of items) {
      const type = resolveType(buffer, name);
      if (!type) {
        unsupported.push({ name, reason: 'Unsupported file type. Allowed: PDF, JPEG, PNG, TXT.' });
        continue;
      }
      prepared.push({ name, buffer, type });
    }
    if (unsupported.length > 0) {
      return NextResponse.json(
        { error: 'Some files cannot be converted to PDF.', failedFiles: unsupported },
        { status: 415 }
      );
    }

    // Phase 3: convert. Every file here passed validation, so a failure now is a
    // real processing error (corrupt file / unsupported variant). Report it
    // instead of embedding a placeholder page and pretending the batch worked.
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const failed: { name: string; reason: string }[] = [];
    for (const { name, buffer, type } of prepared) {
      try {
        await addFileToPdf(pdfDoc, buffer, type, name);
      } catch (error) {
        console.error(`Error processing file ${name}:`, error);
        failed.push({ name, reason: 'The file appears to be corrupt or uses an unsupported variant.' });
      }
    }
    if (failed.length > 0) {
      return NextResponse.json(
        { error: 'Some files could not be processed.', failedFiles: failed },
        { status: 422 }
      );
    }

    const pdfBytes = await pdfDoc.save();

    const outputFilename =
      prepared.length === 1
        ? `${prepared[0].name.replace(/\.[^/.]+$/, '')}.pdf`
        : 'converted-documents.pdf';

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(outputFilename)}"`,
      },
    });
  } catch (error) {
    console.error('Conversion error:', error);
    return NextResponse.json(
      { error: 'Conversion failed. Please try again.' },
      { status: 500 }
    );
  }
}

// Funcție pentru a încărca fontul Roboto cu suport Unicode
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

// Funcție pentru a adăuga un fișier la PDF
async function addFileToPdf(
  pdfDoc: PDFDocument, 
  fileBuffer: Buffer, 
  fileType: string, 
  fileName: string
): Promise<void> {
  switch (fileType) {
    case 'application/pdf': {
      // Dacă este PDF, extragem paginile și le adăugăm
      const pdf = await PDFDocument.load(fileBuffer);
      const pages = await pdfDoc.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => pdfDoc.addPage(page));
      break;
    }

    case 'image/jpeg':
    case 'image/jpg': {
      await addImageToPdf(pdfDoc, fileBuffer, 'jpeg');
      break;
    }

    case 'image/png': {
      await addImageToPdf(pdfDoc, fileBuffer, 'png');
      break;
    }

    case 'text/plain': {
      // Convertim textul și îl adăugăm ca pagină nouă
      await addTextToPdf(pdfDoc, fileBuffer.toString(), fileName);
      break;
    }

    default:
      // Types are validated before conversion; this is defensive only.
      throw new Error(`Unsupported file type reached converter: ${fileType}`);
  }
}

// Funcție pentru a adăuga o imagine la PDF
async function addImageToPdf(pdfDoc: PDFDocument, imageBuffer: Buffer, format: 'jpeg' | 'png'): Promise<void> {
  try {
    let image;
    if (format === 'jpeg') {
      image = await pdfDoc.embedJpg(imageBuffer);
    } else {
      image = await pdfDoc.embedPng(imageBuffer);
    }
    
    // Calculăm dimensiunile pentru a se potrivi pe pagină
    const maxWidth = 550;
    const maxHeight = 750;
    
    let { width, height } = image;
    
    // Redimensionăm dacă este prea mare
    if (width > maxWidth || height > maxHeight) {
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      width *= ratio;
      height *= ratio;
    }
    
    // Adăugăm pagina
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    
    // Centram imaginea
    const x = (595.28 - width) / 2;
    const y = (841.89 - height) / 2;
    
    page.drawImage(image, {
      x,
      y,
      width,
      height,
    });
  } catch (error) {
    console.error('Error adding image:', error);
    throw new Error('Failed to process image');
  }
}

// Funcție pentru a adăuga text la PDF cu suport complet Unicode
async function addTextToPdf(pdfDoc: PDFDocument, text: string, fileName: string): Promise<void> {
  const font = await getUnicodeFont(pdfDoc);
  
  const fontSize = 12; // Redus de la 14 la 12
  const lineHeight = fontSize * 1.3; // Redus spațiul între linii
  const margin = 50; // Redus marginile
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const maxWidth = pageWidth - (margin * 2);
  const maxHeight = pageHeight - (margin * 2);
  
  // Împărțim textul în paragrafe pentru spațiere mai bună
  const paragraphs = text.split(/\n\s*\n/);
  const allLines: string[] = [];
  
  for (const paragraph of paragraphs) {
    if (paragraph.trim()) {
      // Procesăm fiecare paragraf separat
      const words = paragraph.trim().split(/\s+/);
      const paragraphLines: string[] = [];
      let currentLine = '';
      
      for (const word of words) {
        const testLine = currentLine + (currentLine ? ' ' : '') + word;
        const textWidth = font.widthOfTextAtSize(testLine, fontSize);
        
        if (textWidth <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) {
            paragraphLines.push(currentLine);
            currentLine = word;
          } else {
            // Cuvântul este prea lung, îl tăiem
            const maxChars = Math.floor(maxWidth / (fontSize * 0.5));
            paragraphLines.push(word.substring(0, maxChars));
            currentLine = word.substring(maxChars);
          }
        }
      }
      
      if (currentLine) {
        paragraphLines.push(currentLine);
      }
      
      // Adăugăm liniile paragrafului
      allLines.push(...paragraphLines);
      // Adăugăm o linie goală după paragraf pentru spațiere (doar dacă nu e ultimul)
      if (paragraphs.indexOf(paragraph) < paragraphs.length - 1) {
        allLines.push('');
      }
    }
  }
  
  // Calculăm câte pagini avem nevoie
  const linesPerPage = Math.floor((maxHeight - 80) / lineHeight); // -80 pentru header
  const totalPages = Math.ceil(allLines.length / linesPerPage);
  
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    
    // Adăugăm header doar pe prima pagină
    if (pageIndex === 0) {
      page.drawText(`Fișier: ${fileName}`, {
        x: margin,
        y: pageHeight - margin,
        size: fontSize + 2, // Header mai mare
        font,
        color: rgb(0, 0, 0.8),
      });
      
      // Linie separatoare mai vizibilă
      page.drawRectangle({
        x: margin,
        y: pageHeight - margin - 25,
        width: maxWidth,
        height: 1,
        color: rgb(0.7, 0.7, 0.7),
      });
    }
    
    // Calculăm poziția de start pentru text
    const startY = pageIndex === 0 ? pageHeight - margin - 50 : pageHeight - margin - 20;
    
    // Adăugăm textul pentru această pagină
    const startLine = pageIndex * linesPerPage;
    const endLine = Math.min(startLine + linesPerPage, allLines.length);
    
    for (let i = startLine; i < endLine; i++) {
      const line = allLines[i];
      if (line.trim() || i === startLine) { // Afișăm și liniile goale pentru spațiere
        page.drawText(line, {
          x: margin,
          y: startY - ((i - startLine) * lineHeight),
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }
    
    // Adăugăm numărul paginii dacă avem mai multe pagini
    if (totalPages > 1) {
      page.drawText(`Pagina ${pageIndex + 1} din ${totalPages}`, {
        x: pageWidth - margin - 80,
        y: 30,
        size: fontSize - 2,
        font,
        color: rgb(0.5, 0.5, 0.5),
      });
    }
  }
}
