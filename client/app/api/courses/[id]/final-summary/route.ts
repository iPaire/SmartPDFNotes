import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";
import { createChatCompletion } from "@/lib/ai-client";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

// ===================== POST - Generează rezumatul final =====================
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  // Token-bucket limit on LLM usage, per user (POST generates; GET only reads)
  const rateLimit = await checkRateLimit('ai', session.user.id);
  if (!rateLimit.success) {
    return rateLimitResponse(rateLimit) as NextResponse;
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // 1. Obține cursul și rezumatele existente
    const course = await prisma.course.findUnique({
      where: { id: courseId, userId },
      include: {
        summaries: {
          include: { summary: { select: { id: true, title: true, content: true, language: true } } },
          orderBy: { addedAt: 'asc' }
        }
      }
    });

    if (!course) return NextResponse.json({ error: 'Cursul nu a fost găsit' }, { status: 404 });
    if (course.summaries.length === 0) return NextResponse.json({ error: 'Cursul nu conține rezumate' }, { status: 400 });

    // 2. Detectează limba predominantă din rezumate
    const languages = course.summaries.map(cs => cs.summary.language || 'en');
    const languageCount: Record<string, number> = {};
    languages.forEach(lang => languageCount[lang] = (languageCount[lang] || 0) + 1);
    const predominantLanguage = Object.keys(languageCount).reduce((a, b) => languageCount[a] > languageCount[b] ? a : b);

    // 3. Creează text combinat pentru procesare
    const allSummaries = course.summaries.map(cs => ({ title: cs.summary.title, content: cs.summary.content }));
    const combinedText = allSummaries.map((summary, index) => 
      `## Modul ${index + 1}: ${summary.title}\n\n${summary.content}`
    ).join('\n\n---\n\n');

    // 3. Extrage secțiunile local
    const keyConcepts = extractKeyConceptsByModule(combinedText);
    const formulas = extractFormulas(combinedText);
    const definitions = extractDefinitions(combinedText);
    const keyPoints = extractKeyPoints(combinedText);
    const applications = extractPracticalApplications(combinedText);
    const conclusions = extractConclusions(combinedText);

    // 4. Trimite la AI pentru formulare frumoasă
    const finalSummaryContent = await generateCourseFinalSummary(
      course.title, 
      course.description || '', 
      allSummaries.length,
      keyConcepts, formulas, definitions, keyPoints, applications, conclusions,
      predominantLanguage
    );

    // 5. Șterge vechiul rezumat final
    const existingFinalSummary = await prisma.courseSummary.findFirst({
      where: { courseId, summary: { title: { startsWith: 'Rezumat Final -' }, userId } },
      include: { summary: true }
    });

    if (existingFinalSummary) {
      await prisma.courseSummary.delete({ where: { id: existingFinalSummary.id } });
      await prisma.summary.delete({ where: { id: existingFinalSummary.summary.id } });
    }

    // 6. Salvează rezumatul nou
    const finalSummary = await prisma.summary.create({
      data: {
        title: `Rezumat Final - ${course.title}`,
        content: finalSummaryContent,
        userId
      }
    });

    await prisma.courseSummary.create({ data: { courseId, summaryId: finalSummary.id } });

    return NextResponse.json({
      success: true,
      finalSummary: {
        id: finalSummary.id,
        title: finalSummary.title,
        content: finalSummary.content,
        createdAt: finalSummary.createdAt
      },
      sourceCount: allSummaries.length
    });

  } catch (error) {
    console.error('Error generating final summary:', error);
    return NextResponse.json({ error: 'Eroare server la generarea rezumatului final' }, { status: 500 });
  }
}

// ===================== GET - Obține rezumatul final existent =====================
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    const finalSummaryRelation = await prisma.courseSummary.findFirst({
      where: { courseId, summary: { title: { startsWith: 'Rezumat Final -' }, userId } },
      include: { summary: true },
      orderBy: { addedAt: 'desc' }
    });

    if (!finalSummaryRelation) return NextResponse.json({ error: 'Nu există rezumat final pentru acest curs' }, { status: 404 });

    return NextResponse.json({
      finalSummary: {
        id: finalSummaryRelation.summary.id,
        title: finalSummaryRelation.summary.title,
        content: finalSummaryRelation.summary.content,
        createdAt: finalSummaryRelation.summary.createdAt,
        addedAt: finalSummaryRelation.addedAt
      }
    });

  } catch (error) {
    console.error('Error fetching final summary:', error);
    return NextResponse.json({ error: 'Eroare server' }, { status: 500 });
  }
}

// ===================== Prompt AI =====================
async function generateCourseFinalSummary(
  courseTitle: string, 
  courseDescription: string, 
  moduleCount: number,
  keyConcepts: string,
  formulas: string,
  definitions: string,
  keyPoints: string,
  applications: string,
  conclusions: string,
  language: string = 'ro'
): Promise<string> {

  // Language-specific prompts and titles
  const languageConfig = getLanguageConfig(language);
  
  const prompt = `
Creează un rezumat final bine scris pentru cursul "${courseTitle}" folosind următoarele secțiuni extrase automat:

## ${languageConfig.sections.overview}
Descriere: ${courseDescription}
Module studiate: ${moduleCount}

## ${languageConfig.sections.structure}
${keyConcepts}

## ${languageConfig.sections.concepts}
${definitions}

## ${languageConfig.sections.formulas}
${formulas}

## ${languageConfig.sections.keyPoints}
${keyPoints}

## ${languageConfig.sections.applications}
${applications}

## ${languageConfig.sections.conclusion}
${conclusions}

${languageConfig.requirements}
`;

  try {
    // Shared AI client: retries + OpenAI secondary + Claude fallback,
    // instead of a raw fetch with no error handling.
    const result = await createChatCompletion({
      model: "gpt-4o-mini",
      system: "You are an expert educational assistant that produces well-structured course summaries.",
      prompt,
      maxTokens: 3000,
      temperature: 0.3,
    });
    return result.content;
  } catch (error) {
    console.error("Final summary generation failed on all providers:", error);
    return "Eroare la generarea rezumatului.";
  }
}

// ===================== Funcții helper =====================
function extractKeyConceptsByModule(text: string): string {
  const modules = text.split('---');
  let result = '';
  modules.forEach((module, index) => {
    const lines = module.split('\n').filter(line => line.trim().length > 0);
    if (lines.length > 1) {
      const moduleTitle = lines[0]?.replace(/^#+\s*/, '') || `Modul ${index + 1}`;
      const keyPoints = lines.slice(1, 4)
        .filter(line => line.trim().length > 20)
        .map(line => `  • ${line.trim().substring(0, 100)}${line.length > 100 ? '...' : ''}`)
        .join('\n');
      result += `\n### ${moduleTitle}\n${keyPoints}\n`;
    }
  });
  return result || '• Concepte fundamentale ale domeniului studiat';
}

function extractFormulas(text: string): string {
  const formulas: string[] = [];
  const patterns = [
    /\$\$([^$]+)\$\$/g, /\$([^$]+)\$/g,
    /([A-Z][a-z]?\s*=\s*[^.]+)/g, /([a-zA-Z]+\s*=\s*[0-9][^.]*)/g
  ];
  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const formula = match[1] || match[0];
      if (formula.length > 3 && formula.length < 100) formulas.push(`• ${formula.trim()}`);
    }
  });
  return formulas.length > 0 ? formulas.slice(0, 10).join('\n') : '• Formule specifice domeniului studiat';
}

function extractDefinitions(text: string): string {
  const definitions: string[] = [];
  const lines = text.split('\n');
  lines.forEach(line => {
    if ((line.includes('este') || line.includes('reprezintă') || line.includes('se definește')) && 
        line.length > 20 && line.length < 200) {
      definitions.push(`► ${line.trim()}`);
    }
  });
  return definitions.length > 0 ? definitions.slice(0, 8).join('\n') : '► Definiții fundamentale ale conceptelor studiate';
}

function extractKeyPoints(text: string): string {
  const keyPoints: string[] = [];
  const indicators = ['important', 'esențial', 'fundamental', 'crucial', 'principal', 'trebuie', 'necesar', 'cheie', 'vital'];
  const sentences = text.split(/[.!?]+/);
  sentences.forEach(sentence => {
    const lowerSentence = sentence.toLowerCase();
    if (indicators.some(ind => lowerSentence.includes(ind)) && sentence.length > 30 && sentence.length < 200) {
      keyPoints.push(`- ${sentence.trim()}`);
    }
  });
  return keyPoints.length > 0 ? keyPoints.slice(0, 6).join('\n') : '- Concepte și principii fundamentale ale cursului';
}

function extractPracticalApplications(text: string): string {
  const applications: string[] = [];
  const indicators = ['aplicare', 'practică', 'exemplu', 'utilizare', 'implementare', 'folosire', 'aplicație', 'caz', 'situație', 'experiment'];
  const sentences = text.split(/[.!?]+/);
  sentences.forEach(sentence => {
    const lowerSentence = sentence.toLowerCase();
    if (indicators.some(ind => lowerSentence.includes(ind)) && sentence.length > 25 && sentence.length < 180) {
      applications.push(`- ${sentence.trim()}`);
    }
  });
  return applications.length > 0 ? applications.slice(0, 5).join('\n') : '- Aplicații practice în domeniul studiat';
}

function extractConclusions(text: string): string {
  const conclusions: string[] = [];
  const indicators = ['concluzie', 'în final', 'prin urmare', 'rezultă că', 'se poate spune', 'în rezumat', 'astfel', 'în consecință'];
  const sentences = text.split(/[.!?]+/);
  sentences.forEach(sentence => {
    const lowerSentence = sentence.toLowerCase();
    if (indicators.some(ind => lowerSentence.includes(ind)) && sentence.length > 30) {
      conclusions.push(sentence.trim());
    }
  });
  return conclusions.length > 0 ? conclusions.slice(-2).join(' ') : '';
}

// Language-specific configuration
function getLanguageConfig(language: string) {
  const configs = {
    'ro': {
      sections: {
        overview: 'Prezentare Generală',
        structure: 'Structura Cursului', 
        concepts: 'Concepte Fundamentale',
        formulas: 'Formule și Relații Cheie',
        keyPoints: 'Puncte Esențiale',
        applications: 'Aplicații Practice',
        conclusion: 'Concluzie'
      },
      requirements: `Cerințe:
- Formulează frumos, coerent și fluent în limba română.
- Păstrează toate informațiile importante.
- Structura finală trebuie să aibă aceleași titluri și ordine.`
    },
    'en': {
      sections: {
        overview: 'General Overview',
        structure: 'Course Structure',
        concepts: 'Fundamental Concepts', 
        formulas: 'Key Formulas and Relations',
        keyPoints: 'Essential Points',
        applications: 'Practical Applications',
        conclusion: 'Conclusion'
      },
      requirements: `Requirements:
- Write beautifully, coherently and fluently in English.
- Keep all important information.
- The final structure must have the same titles and order.`
    },
    'fr': {
      sections: {
        overview: 'Présentation Générale',
        structure: 'Structure du Cours',
        concepts: 'Concepts Fondamentaux',
        formulas: 'Formules et Relations Clés', 
        keyPoints: 'Points Essentiels',
        applications: 'Applications Pratiques',
        conclusion: 'Conclusion'
      },
      requirements: `Exigences:
- Formulez de manière belle, cohérente et fluide en français.
- Conservez toutes les informations importantes.
- La structure finale doit avoir les mêmes titres et ordre.`
    },
    'de': {
      sections: {
        overview: 'Allgemeine Übersicht',
        structure: 'Kursstruktur',
        concepts: 'Grundlegende Konzepte',
        formulas: 'Wichtige Formeln und Beziehungen',
        keyPoints: 'Wesentliche Punkte', 
        applications: 'Praktische Anwendungen',
        conclusion: 'Fazit'
      },
      requirements: `Anforderungen:
- Formulieren Sie schön, kohärent und fließend auf Deutsch.
- Behalten Sie alle wichtigen Informationen bei.
- Die endgültige Struktur muss dieselben Titel und Reihenfolge haben.`
    },
    'es': {
      sections: {
        overview: 'Visión General',
        structure: 'Estructura del Curso',
        concepts: 'Conceptos Fundamentales',
        formulas: 'Fórmulas y Relaciones Clave',
        keyPoints: 'Puntos Esenciales',
        applications: 'Aplicaciones Prácticas', 
        conclusion: 'Conclusión'
      },
      requirements: `Requisitos:
- Formule de manera hermosa, coherente y fluida en español.
- Conserve toda la información importante.
- La estructura final debe tener los mismos títulos y orden.`
    }
  };
  
  return configs[language as keyof typeof configs] || configs['en'];
}
