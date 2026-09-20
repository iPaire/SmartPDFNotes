// lib/pdf-diagrams.ts - Extracts probable diagram/schematic pages from a PDF
// as PNG images, with zero AI cost. Detection is a pure text heuristic
// (diagram pages extract very little text, or mostly component labels like
// R1/C2/AO); rendering uses pdfjs + @napi-rs/canvas. Runs post-response via
// next/server `after()` so it can never slow down or break summarization.
import prisma from './prisma';
import { uploadDiagram, storageConfigured } from './supabase-storage';

// Runs inside the summarize function's remaining time budget (maxDuration
// 60s, most of it spent on the LLM) - keep rendering cheap.
const MAX_DIAGRAM_PAGES = 6;
const RENDER_SCALE = 1.5; // A4 -> ~893x1263 px

export interface DiagramRef {
  page: number;
  path: string;
}

/**
 * Text signals of a schematic/diagram page: very little extractable text,
 * or a high density of component-style labels relative to prose.
 */
export function looksLikeDiagramPage(pageText: string, pageNumber: number): boolean {
  const text = pageText.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Fully graphical page (nothing but the figure).
  if (wordCount === 0) return pageNumber > 1;

  const componentRefs = (
    text.match(/\b(?:R|C|L|D|Q|T|U|AO|OA)_?\d+\b|\bV_?(?:in|out|IN|OUT|i|o)\b|\bU_?(?:in|out|1|2)\b/g) || []
  ).length;
  const density = componentRefs / wordCount;

  // Skip the first page for the low-text rule alone - title pages are
  // sparse too - but a component-label cluster is a signal anywhere.
  if (density > 0.12 && componentRefs >= 3) return true;
  if (pageNumber > 1 && wordCount < 40) return true;
  return false;
}

/** Pick up to MAX_DIAGRAM_PAGES candidate pages (1-based numbers). */
export function detectDiagramPages(pageTexts: string[]): number[] {
  const pages: number[] = [];
  pageTexts.forEach((text, i) => {
    if (looksLikeDiagramPage(text, i + 1)) pages.push(i + 1);
  });
  return pages.slice(0, MAX_DIAGRAM_PAGES);
}

/** Render the given 1-based pages of a PDF to PNG buffers. */
async function renderPagesToPng(
  pdfBuffer: ArrayBuffer,
  pages: number[]
): Promise<{ page: number; png: Buffer }[]> {
  // Dynamic import: heavy, server-only, listed in serverExternalPackages -
  // keeps it out of every other route's graph. In Node, pdfjs uses
  // @napi-rs/canvas internally via the document's canvasFactory; the
  // standard-font/cmap dirs are needed for glyph rendering (traced into the
  // Vercel bundle via outputFileTracingIncludes in next.config).
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const path = await import('path');

  const pdfjsData = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: path.join(pdfjsData, 'standard_fonts') + path.sep,
    cMapUrl: path.join(pdfjsData, 'cmaps') + path.sep,
    cMapPacked: true,
  }).promise;

  const out: { page: number; png: Buffer }[] = [];
  try {
    const canvasFactory = (
      doc as unknown as {
        canvasFactory: {
          create(width: number, height: number): {
            canvas: { width: number; height: number; toBuffer(mime: 'image/png'): Buffer };
            context: CanvasRenderingContext2D;
          };
        };
      }
    ).canvasFactory;
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      // Per-page isolation: one unrenderable page must not lose the rest.
      try {
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const { canvas, context } = canvasFactory.create(
          Math.ceil(viewport.width),
          Math.ceil(viewport.height)
        );
        // White background: PDF pages are transparent by default.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: context, viewport }).promise;
        out.push({ page: pageNumber, png: canvas.toBuffer('image/png') });
        page.cleanup();
      } catch (pageError) {
        console.warn(`[diagrams] page ${pageNumber} failed to render:`, pageError);
      }
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/**
 * Full pipeline: detect -> render -> upload -> persist as a 'diagrams'
 * WorkspaceArtifact on the summary. Never throws (logs and returns) so the
 * caller's flow is unaffected by a rendering failure.
 */
export async function generateDiagramsArtifact(
  summaryId: string,
  userId: string,
  pdfBuffer: ArrayBuffer,
  pageTexts: string[]
): Promise<void> {
  const startedAt = Date.now();
  try {
    if (!storageConfigured()) {
      console.warn('[diagrams] storage not configured, skipping');
      return;
    }

    const pages = detectDiagramPages(pageTexts);
    console.log(`[diagrams] summary ${summaryId}: ${pageTexts.length} pages scanned, candidates: [${pages.join(', ')}]`);
    if (pages.length === 0) return;

    const rendered = await renderPagesToPng(pdfBuffer, pages);
    console.log(`[diagrams] rendered ${rendered.length}/${pages.length} pages in ${Date.now() - startedAt}ms`);
    if (rendered.length === 0) return;

    const refs: DiagramRef[] = [];
    for (const { page, png } of rendered) {
      const path = `${userId}/${summaryId}/page-${page}.png`;
      await uploadDiagram(path, png);
      refs.push({ page, path });
    }

    await prisma.workspaceArtifact.upsert({
      where: { summaryId_type: { summaryId, type: 'diagrams' } },
      create: {
        summaryId,
        userId,
        type: 'diagrams',
        content: { pages: refs } as object,
      },
      update: { content: { pages: refs } as object, updatedAt: new Date() },
    });

    console.log(`[diagrams] stored ${refs.length} diagram pages for summary ${summaryId} (total ${Date.now() - startedAt}ms)`);

    // Diagrams finish AFTER the user landed in the workspace - without a
    // notification they would never know to refresh.
    await prisma.notification.create({
      data: {
        userId,
        type: 'diagrams_ready',
        payload: { count: refs.length },
        href: `/workspace/${summaryId}`,
      },
    }).catch((e) => console.error('[diagrams] notification create failed:', e));
  } catch (error) {
    console.error(`[diagrams] generation failed for summary ${summaryId}:`, error);
  }
}
