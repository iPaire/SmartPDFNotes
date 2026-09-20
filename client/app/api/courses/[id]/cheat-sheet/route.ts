import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { generateRelevantFormulas, generateKeyDefinitions, getFormulaGenerationPrompt, getDefinitionsGenerationPrompt, parseFormulasFromAIResponse, parseDefinitionsFromAIResponse } from '@/ai-functions';

// POST - Generate printable cheat sheet
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Token-bucket limit on LLM usage, per user (POST fans out to two AI calls)
  const rateLimit = await checkRateLimit('ai', session.user.id);
  if (!rateLimit.success) {
    return rateLimitResponse(rateLimit) as NextResponse;
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // 1. Get course with summaries
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      },
      include: {
        summaries: {
          include: {
            summary: {
              select: {
                id: true,
                title: true,
                content: true,
                language: true
              }
            }
          },
          orderBy: {
            addedAt: 'asc'
          }
        }
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 });
    }

    if (course.summaries.length === 0) {
      return NextResponse.json({ error: 'Course has no summaries' }, { status: 400 });
    }

    // 2. Detect predominant language from summaries
    const languages = course.summaries.map(cs => cs.summary.language || 'en');
    const languageCount: Record<string, number> = {};
    languages.forEach(lang => languageCount[lang] = (languageCount[lang] || 0) + 1);
    const predominantLanguage = Object.keys(languageCount).reduce((a, b) => languageCount[a] > languageCount[b] ? a : b);

    // 3. Combine all summaries
    const combinedText = course.summaries.map(cs => 
      `## ${cs.summary.title}\n\n${cs.summary.content}`
    ).join('\n\n---\n\n');

    // 4. Generate cheat sheet using AI-enhanced function
    const cheatSheetContent = await generateEnhancedCheatSheet(
      course.title,
      combinedText,
      predominantLanguage
    );

    // 4. Save cheat sheet to database
    await prisma.cheatSheet.create({
      data: {
        content: cheatSheetContent,
        courseId: courseId,
        userId: userId
      }
    });

    return NextResponse.json({
      success: true,
      cheatSheet: cheatSheetContent,
      courseTitle: course.title
    });

  } catch (error) {
    console.error('Error generating cheat sheet:', error);
    return NextResponse.json(
      { error: 'Server error generating cheat sheet' },
      { status: 500 }
    );
  }
}

// GET - Get existing cheat sheets
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // Verify course ownership
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Course not found' }, { status: 404 });
    }

    // Get all cheat sheets for this course
    const cheatSheets = await prisma.cheatSheet.findMany({
      where: {
        courseId: courseId
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({
      cheatSheets: cheatSheets.map(cs => ({
        id: cs.id,
        content: cs.content,
        createdAt: cs.createdAt
      })),
      courseTitle: course.title
    });

  } catch (error) {
    console.error('Error fetching cheat sheets:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// DELETE - Delete a cheat sheet
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;
  const { cheatSheetId } = await req.json();

  try {
    // Verify ownership
    const cheatSheet = await prisma.cheatSheet.findFirst({
      where: {
        id: cheatSheetId,
        courseId: courseId,
        userId: userId
      }
    });

    if (!cheatSheet) {
      return NextResponse.json({ error: 'Cheat sheet not found' }, { status: 404 });
    }

    // Delete the cheat sheet
    await prisma.cheatSheet.delete({
      where: {
        id: cheatSheetId
      }
    });

    return NextResponse.json({
      success: true,
      message: 'Cheat sheet deleted'
    });

  } catch (error) {
    console.error('Error deleting cheat sheet:', error);
    return NextResponse.json(
      { error: 'Server error deleting cheat sheet' },
      { status: 500 }
    );
  }
}

// ============== HELPER FUNCTIONS ==============

// Enhanced cheat sheet generation with AI-generated formulas
async function generateEnhancedCheatSheet(courseTitle: string, combinedContent: string, language: string = 'en'): Promise<string> {
  // Get AI-enhanced content
  const enhancedFormulas = await generateRelevantFormulas(courseTitle, combinedContent, language);
  const enhancedDefinitions = await generateKeyDefinitions(courseTitle, combinedContent, language);
  
  // Extract existing content
  const existingFormulas = extractFormulas(combinedContent);
  const existingDefinitions = extractDefinitions(combinedContent);
  const procedures = extractProcedures(combinedContent);
  const constants = extractConstants(combinedContent);
  
  // Combine AI-generated with existing content
  const allFormulas = [...enhancedFormulas, ...existingFormulas].slice(0, 12);
  const allDefinitions = [...enhancedDefinitions, ...existingDefinitions].slice(0, 10);
  
  return generateCheatSheetHTML(courseTitle, {
    formulas: allFormulas,
    definitions: allDefinitions,
    procedures,
    constants
  }, language);
}


function generateCheatSheetHTML(courseTitle: string, content: {
  formulas: string[];
  definitions: Array<{term: string, definition: string}>;
  procedures: string[];
  constants: string[];
}, language: string = 'en'): string {
  const { formulas, definitions, procedures, constants } = content;
  
  // Language-specific labels
  const labels = getCheatSheetLabels(language);

  return `
<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${labels.cheatsheet} - ${escapeHtml(courseTitle)}</title>
  <style>
    @page {
      size: A4;
      margin: 10mm;
    }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 8pt;
      line-height: 1.3;
      margin: 0;
      padding: 4mm;
      color: #333;
      background: white;
      max-width: 210mm;
      margin: 0 auto;
      column-count: 2;
      column-gap: 5mm;
      column-rule: 1px solid #e2e8f0;
    }
    .header {
      text-align: center;
      margin-bottom: 4mm;
      padding-bottom: 2mm;
      border-bottom: 1px solid #2c5282;
    }
    .title {
      font-size: 14pt;
      font-weight: bold;
      color: #2c5282;
      margin: 0;
    }
    .subtitle {
      font-size: 8pt;
      color: #718096;
      margin: 1mm 0 0;
    }
    .content {
      column-span: none;
      break-inside: avoid;
      margin-bottom: 3mm;
    }
    .full-width {
      column-span: all;
      margin-bottom: 2mm;
    }
    .section {
      margin-bottom: 3mm;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .section-title {
      font-size: 9pt;
      font-weight: 600;
      color: #2c5282;
      background: #ebf8ff;
      padding: 1.5mm 2mm;
      border-left: 2px solid #2c5282;
      margin: 0 0 1.5mm;
    }
    .items {
      padding-left: 2mm;
    }
    .item {
      margin-bottom: 1mm;
      font-size: 7.5pt;
    }
    .formula {
      font-family: 'Cambria Math', 'Times New Roman', serif;
      font-size: 8pt;
      padding: 0.5mm 0;
      font-weight: 500;
      background: #f8fafc;
      border-radius: 2px;
      padding: 1mm 2mm;
      margin: 0.5mm 0;
    }
    .definition {
      display: block;
      margin-bottom: 1mm;
      line-height: 1.2;
    }
    .term {
      font-weight: 600;
      color: #2c5282;
      display: inline;
    }
    .definition-compact {
      font-size: 7pt;
      margin-bottom: 0.8mm;
      line-height: 1.2;
    }
    .term-compact {
      font-weight: 600;
      color: #2c5282;
    }
    .workspace-area {
      border: 1px solid #e2e8f0;
      padding: 3mm;
      margin-top: 2mm;
    }
    .workspace-title {
      font-size: 8pt;
      font-weight: 600;
      color: #4a5568;
      margin-bottom: 1mm;
    }
    .calculation-space {
      border: 1px dashed #cbd5e0;
      height: 15mm;
      margin-bottom: 3mm;
    }
    .notes-space-large {
      border: 1px dashed #cbd5e0;
      height: 20mm;
    }
    .footer {
      margin-top: 4mm;
      padding-top: 2mm;
      border-top: 1px solid #e2e8f0;
      font-size: 7pt;
      color: #718096;
      text-align: center;
    }
    .notation {
      display: flex;
      justify-content: space-between;
      margin-top: 2mm;
    }
    .notation-item {
      flex: 1;
      padding: 0 2mm;
    }
    .notes-space {
      border: 1px solid #cbd5e0;
      height: 15mm;
      margin-top: 1mm;
    }
    @media print {
      body {
        padding: 0;
        font-size: 7pt;
      }
      .section-title {
        font-size: 8pt;
      }
      .formula {
        font-size: 7.5pt;
      }
      .header {
        margin-bottom: 3mm;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="title">${escapeHtml(courseTitle)}</h1>
    <p class="subtitle">${labels.subtitle}</p>
  </div>

  <!-- Formule și constante în partea de sus -->
  ${formulas.length > 0 ? `
    <div class="section full-width">
      <h2 class="section-title">${labels.formulas}</h2>
      <div class="items" style="columns: 2; column-gap: 3mm;">
        ${formulas.map(f => `
          <div class="item formula">${escapeHtml(f)}</div>
        `).join('')}
      </div>
    </div>
  ` : ''}

  <!-- Definițiile principale -->
  ${definitions.slice(0, 8).length > 0 ? `
    <div class="section content">
      <h2 class="section-title">${labels.definitions}</h2>
      <div class="items">
        ${definitions.slice(0, 8).map(d => `
          <div class="item definition">
            <span class="term">${escapeHtml(d.term)}:</span><br>
            <span style="font-size: 7pt; color: #4a5568;">${escapeHtml(d.definition)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : ''}

  <!-- Constante -->
  ${constants.length > 0 ? `
    <div class="section content">
      <h2 class="section-title">${labels.constants}</h2>
      <div class="items">
        ${constants.map(c => `
          <div class="item" style="font-family: monospace; font-size: 7.5pt;">${escapeHtml(c)}</div>
        `).join('')}
      </div>
    </div>
  ` : ''}

  <!-- Proceduri -->
  ${procedures.length > 0 ? `
    <div class="section content">
      <h2 class="section-title">${labels.procedures}</h2>
      <div class="items">
        ${procedures.slice(0, 4).map((p, i) => `
          <div class="item" style="font-size: 7pt;">
            <strong style="color: #2c5282;">${i+1}.</strong> ${escapeHtml(p.substring(0, 100))}${p.length > 100 ? '...' : ''}
          </div>
        `).join('')}
      </div>
    </div>
  ` : ''}

  <!-- Spațiu de lucru -->
  <div class="section content">
    <h2 class="section-title">${labels.workspace}</h2>
    <div class="workspace-area" style="height: 25mm; border: 1px dashed #cbd5e0; padding: 2mm;">
      <div style="font-size: 7pt; color: #718096; margin-bottom: 2mm;">${labels.calculations}:</div>
      <div style="border-bottom: 1px dotted #cbd5e0; height: 8mm; margin-bottom: 2mm;"></div>
      <div style="font-size: 7pt; color: #718096; margin-bottom: 1mm;">${labels.notes}:</div>
      <div style="border-bottom: 1px dotted #cbd5e0; height: 8mm;"></div>
    </div>
  </div>

  <div class="footer">
    <div class="notation">
      <div class="notation-item">
        <strong>${labels.notations}:</strong><br>
        ${labels.notationExamples}
      </div>
      <div class="notation-item">
        <strong>${labels.units}:</strong><br>
        ${labels.unitExamples}
      </div>
      <div class="notation-item">
        <strong>${labels.notes}:</strong>
        <div class="notes-space"></div>
      </div>
    </div>
    <p>${labels.generated} • ${new Date().toLocaleDateString(getLocaleFromLanguage(language))}</p>
  </div>
</body>
</html>
  `;
}

// Helper function to escape HTML
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Extract formulas from text
function extractFormulas(text: string): string[] {
  const formulas: string[] = [];
  const cleanText = text.replace(/<[^>]*>/g, ''); // Remove HTML tags
  
  // Mathematical expressions patterns
  const patterns = [
    // LaTeX style formulas
    /\$\$([^$]+)\$\$/g,
    /\$([^$]+)\$/g,
    // Equations with equals
    /([A-Za-z]\w*\s*=\s*[^.!?\n]+)/g,
    // Mathematical expressions
    /([a-zA-Z]+\(\w+\)\s*=\s*[^.!?\n]+)/g,
    // Physics/Math constants
    /([A-Z][a-z]?\s*=\s*[0-9][^.!?\n]*)/g,
    // Fractions and ratios
    /(\w+\/\w+\s*=\s*[^.!?\n]+)/g
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(cleanText)) !== null) {
      const formula = (match[1] || match[0]).trim();
      if (formula.length > 3 && formula.length < 150 && !formulas.includes(formula)) {
        formulas.push(formula);
      }
    }
  });

  return formulas.slice(0, 15); // Limit to 15 formulas
}

// Extract definitions from text
function extractDefinitions(text: string): Array<{term: string, definition: string}> {
  const definitions: Array<{term: string, definition: string}> = [];
  const cleanText = text.replace(/<[^>]*>/g, '');
  
  const sentences = cleanText.split(/[.!?]+/);
  
  sentences.forEach(sentence => {
    const trimmed = sentence.trim();
    if (trimmed.length < 20 || trimmed.length > 300) return;
    
    // Pattern: "Term este/reprezintă/se definește ca..."
    const defPatterns = [
      /^([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s]{2,30})\s+(este|reprezintă|se definește ca|înseamnă)\s+(.+)/i,
      /^([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s]{2,30}):\s*(.+)/
    ];
    
    defPatterns.forEach(pattern => {
      const match = trimmed.match(pattern);
      if (match) {
        const term = match[1].trim();
        const definition = (match[3] || match[2]).trim();
        
        if (term.length > 2 && term.length < 50 && definition.length > 10) {
          definitions.push({ term, definition });
        }
      }
    });
  });

  return definitions.slice(0, 10); // Limit to 10 definitions
}

// Extract key terms
function extractKeyTerms(text: string): string[] {
  const keyTerms: string[] = [];
  const cleanText = text.replace(/<[^>]*>/g, '');
  
  // Look for capitalized terms, technical terms, etc.
  const patterns = [
    /\b([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ]{3,25})\b/g,
    /\b(algoritm|metodă|principiu|teoremă|legea?|regulă|proces|procedură|tehnică)\s+([A-Za-zăâîșțĂÂÎȘȚ\s]{3,30})/gi
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(cleanText)) !== null) {
      const term = (match[2] || match[1]).trim();
      if (term.length > 3 && term.length < 40 && !keyTerms.includes(term)) {
        keyTerms.push(term);
      }
    }
  });

  return keyTerms.slice(0, 20); // Limit to 20 key terms
}

// Extract procedures/steps
function extractProcedures(text: string): string[] {
  const procedures: string[] = [];
  const cleanText = text.replace(/<[^>]*>/g, '');
  
  const lines = cleanText.split('\n');
  
  lines.forEach(line => {
    const trimmed = line.trim();
    
    // Look for numbered steps or procedural language
    if (/^(\d+\.|Pasul \d+|Step \d+|Prima data|În primul rând|Apoi|După aceea|În final)/i.test(trimmed)) {
      const cleaned = trimmed.replace(/^(\d+\.|Pasul \d+|Step \d+)\s*/i, '').trim();
      if (cleaned.length > 10 && cleaned.length < 200) {
        procedures.push(cleaned);
      }
    }
  });

  return procedures.slice(0, 8); // Limit to 8 procedures
}

// Extract constants
function extractConstants(text: string): string[] {
  const constants: string[] = [];
  const cleanText = text.replace(/<[^>]*>/g, '');
  
  const patterns = [
    // Physical constants
    /(π\s*=\s*[0-9.]+|e\s*=\s*[0-9.]+|c\s*=\s*[0-9.]+)/g,
    // Named constants
    /([A-Z_]+\s*=\s*[0-9.]+[a-zA-Z]*)/g,
    // Mathematical constants
    /(constanta\s+[A-Za-z]+\s*=\s*[0-9.]+)/gi
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(cleanText)) !== null) {
      const constant = match[1] || match[0];
      if (constant.length > 3 && constant.length < 50 && !constants.includes(constant)) {
        constants.push(constant);
      }
    }
  });

  return constants.slice(0, 10); // Limit to 10 constants
}

// Extract diagram concepts
function extractDiagramConcepts(text: string): string[] {
  const diagrams: string[] = [];
  const cleanText = text.replace(/<[^>]*>/g, '');
  
  const keywords = ['diagramă', 'grafic', 'schemă', 'figura', 'tabel', 'hartă', 'plan', 'desen'];
  
  const sentences = cleanText.split(/[.!?]+/);
  
  sentences.forEach(sentence => {
    const lowerSentence = sentence.toLowerCase();
    
    keywords.forEach(keyword => {
      if (lowerSentence.includes(keyword) && sentence.length > 20 && sentence.length < 150) {
        const cleaned = sentence.trim().replace(/^(vezi|consultă|observă)\s*/i, '');
        if (!diagrams.includes(cleaned)) {
          diagrams.push(cleaned);
        }
      }
    });
  });

  return diagrams.slice(0, 5); // Limit to 5 diagram concepts
}

// Language-specific labels for cheat sheet
function getCheatSheetLabels(language: string) {
  const labels = {
    'ro': {
      cheatsheet: 'Copiuță',
      subtitle: 'Copiuță de formule și concepte',
      formulas: 'Formule Cheie',
      definitions: 'Definiții',
      constants: 'Constante',
      quickReference: 'Referință Rapidă',
      procedures: 'Proceduri',
      workspace: 'Spațiu de Lucru',
      calculations: 'Calcule',
      notes: 'Notițe',
      notations: 'Notații',
      notationExamples: 'f(x) - funcție, Δ - variație, ∑ - sumă',
      units: 'Unități',
      unitExamples: 'm - metri, s - secunde, kg - kilograme',
      generated: 'Generat automat'
    },
    'en': {
      cheatsheet: 'Cheat Sheet',
      subtitle: 'Formula and concept reference',
      formulas: 'Key Formulas',
      definitions: 'Definitions',
      constants: 'Constants',
      quickReference: 'Quick Reference',
      procedures: 'Procedures', 
      workspace: 'Workspace',
      calculations: 'Calculations',
      notes: 'Notes',
      notations: 'Notations',
      notationExamples: 'f(x) - function, Δ - variation, ∑ - sum',
      units: 'Units',
      unitExamples: 'm - meters, s - seconds, kg - kilograms',
      generated: 'Auto-generated'
    },
    'fr': {
      cheatsheet: 'Aide-mémoire',
      subtitle: 'Référence de formules et concepts',
      formulas: 'Formules Clés',
      definitions: 'Définitions',
      constants: 'Constantes',
      quickReference: 'Référence Rapide',
      procedures: 'Procédures',
      workspace: 'Espace de Travail',
      calculations: 'Calculs',
      notes: 'Notes',
      notations: 'Notations',
      notationExamples: 'f(x) - fonction, Δ - variation, ∑ - somme',
      units: 'Unités',
      unitExamples: 'm - mètres, s - secondes, kg - kilogrammes',
      generated: 'Généré automatiquement'
    },
    'de': {
      cheatsheet: 'Spickzettel',
      subtitle: 'Formel- und Konzeptreferenz',
      formulas: 'Wichtige Formeln',
      definitions: 'Definitionen',
      constants: 'Konstanten',
      quickReference: 'Schnellreferenz',
      procedures: 'Verfahren',
      workspace: 'Arbeitsbereich',
      calculations: 'Berechnungen',
      notes: 'Notizen',
      notations: 'Notationen',
      notationExamples: 'f(x) - Funktion, Δ - Variation, ∑ - Summe',
      units: 'Einheiten',
      unitExamples: 'm - Meter, s - Sekunden, kg - Kilogramm',
      generated: 'Automatisch generiert'
    },
    'es': {
      cheatsheet: 'Hoja de Referencia',
      subtitle: 'Referencia de fórmulas y conceptos',
      formulas: 'Fórmulas Clave',
      definitions: 'Definiciones',
      constants: 'Constantes',
      quickReference: 'Referencia Rápida',
      procedures: 'Procedimientos',
      workspace: 'Espacio de Trabajo', 
      calculations: 'Cálculos',
      notes: 'Notas',
      notations: 'Notaciones',
      notationExamples: 'f(x) - función, Δ - variación, ∑ - suma',
      units: 'Unidades',
      unitExamples: 'm - metros, s - segundos, kg - kilogramos',
      generated: 'Generado automáticamente'
    }
  };
  
  return labels[language as keyof typeof labels] || labels['en'];
}

// Convert language code to locale for date formatting
function getLocaleFromLanguage(language: string): string {
  const localeMap = {
    'ro': 'ro-RO',
    'en': 'en-US',
    'fr': 'fr-FR',
    'de': 'de-DE',
    'es': 'es-ES'
  };
  
  return localeMap[language as keyof typeof localeMap] || 'en-US';
}
