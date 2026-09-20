// app/api/summaries/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

// Funcție pentru îmbunătățirea formatării și structurii
function improveFormatting(summary: string, title: string = '', createdAt: Date = new Date()): string {
  let improved = summary;

  // Înlocuiește date placeholder cu date reale
  const currentDate = new Date().toLocaleDateString('ro-RO');
  const createdDate = createdAt.toLocaleDateString('ro-RO');
  improved = improved.replace(/\[data curentă\]/g, currentDate);
  improved = improved.replace(/\[data generării\]/g, createdDate);
  improved = improved.replace(/\[nume fisier\]/g, title);

  // Adaugă separatori pentru secțiuni mari
  improved = improved.replace(/(#{1,3}\s*\*\*[^*]+\*\*)/g, '\n\n$1');

  // Rezumatele noi conțin LaTeX real ($...$) randat de KaTeX; regex-urile de
  // mai jos sunt doar pentru output legacy și ar corupe LaTeX-ul.
  const hasLatexMath = /\$[^$\n]+\$|\$\$[\s\S]+?\$\$/.test(improved);

  // Îmbunătățește formatarea formulelor - păstrează exact din text
  // Pentru formule simple cu egale
  if (!hasLatexMath) improved = improved.replace(/([A-Za-z_]+\s*[=≈≤≥<>]\s*[A-Za-z0-9\s+\-*/()^.\\{}]+)(?=\s|$|\n)/g, (match) => {
    if (!match.includes('**Formulă:**')) {
      return `\n\n**Formulă:** \`${match.trim()}\`\n`;
    }
    return match;
  });

  // Pentru formule LaTeX
  if (!hasLatexMath) improved = improved.replace(/(\\frac\{[^}]+\}\{[^}]+\})/g, (match) => {
    return `\n\n**Formulă:** \`${match}\`\n`;
  });

  // Pentru formule cu indici
  if (!hasLatexMath) improved = improved.replace(/([A-Za-z_]+_{[^}]+}[^a-zA-Z]*[=≈≤≥<>][^=]*)/g, (match) => {
    if (!match.includes('**Formulă:**')) {
      return `\n\n**Formulă:** \`${match.trim()}\`\n`;
    }
    return match;
  });

  // Evidențiază valorile numerice cu unități. Spațiul dintre număr și
  // unitate e obligatoriu (altfel prindea numerotarea "6.1. Titlu"), iar
  // lookahead-ul include diacriticele ca să nu taie cuvinte românești.
  if (!hasLatexMath) improved = improved.replace(
    /(?<![\w.])(\d+(?:[.,]\d+)?)\s+([A-Za-zΩ%µ]{1,4})(?![\wțșăîâȚȘĂÎÂ])/g,
    '**$1 $2**'
  );
  
  // Îmbunătățește formatarea listelor
  improved = improved.replace(/^(\s*-)(\s*)/gm, '- ');
  
  // Formatare îmbunătățită pentru tabele - asigură header corect
  improved = improved.replace(/\|([^|\n]+\|[^|\n]+\|[^|\n]+)\|/g, '| $1 |');
  improved = improved.replace(/^\s*\|([^|]+)\|([^|]+)\|([^|]+)\|\s*$/gm, '| $1 | $2 | $3 |');
  
  // Adaugă separatori pentru tabele dacă lipsesc
  const tableRegex = /(\|[^|\n]+\|[^|\n]+\|[^|\n]+\|)\s*\n(?!\|[\-\s|]+\|)/g;
  improved = improved.replace(tableRegex, '$1\n|---|---|---|\n');
  
  // Formatare îmbunătățită pentru tabele cu multiple coloane
  const tableMatches = improved.match(/\|[^|\n]+\|[^|\n]+\|[^|\n]+\|[^|\n]*\|?/g);
  if (tableMatches) {
    tableMatches.forEach(table => {
      const columns = table.split('|').filter(col => col.trim());
      if (columns.length >= 3) {
        const formattedRow = '| ' + columns.join(' | ') + ' |';
        improved = improved.replace(table, formattedRow);
      }
    });
  }
  
  // Curăță duplicatele de spații și linii goale
  improved = improved.replace(/\n{3,}/g, '\n\n');
  improved = improved.replace(/\s+$/gm, '');
  
  return improved.trim();
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: summaryId } = await context.params;
  const userId = session.user.id;

  try {
    console.log('Fetching summary:', summaryId, 'for user:', userId);

    // Obține rezumatul cu verificarea că aparține utilizatorului
    const summary = await prisma.summary.findFirst({
      where: { 
        id: summaryId,
        userId: userId // Verifică că rezumatul aparține utilizatorului
      },
      include: {
        courses: {
          include: {
            course: {
              select: {
                id: true,
                title: true
              }
            }
          }
        }
      }
    });

    if (!summary) {
      return NextResponse.json({ 
        error: "Rezumatul nu a fost găsit sau nu ai permisiunea să îl vizualizezi" 
      }, { status: 404 });
    }

    // Îmbunătățește formatarea conținutului înainte de a-l trimite
    const improvedContent = improveFormatting(summary.content, summary.title, summary.createdAt);
    
    // Formatează răspunsul pentru frontend
    const formattedSummary = {
      id: summary.id,
      title: summary.title,
      content: improvedContent,
      createdAt: summary.createdAt,
      userId: summary.userId,
      coursesCount: summary.courses.length,
      courses: summary.courses.map(cs => ({
        id: cs.course.id,
        title: cs.course.title
      })),
      // Pentru compatibilitate cu codul vechi
      name: summary.title,
      summary: improvedContent
    };

    console.log('Summary found and formatted');
    return NextResponse.json(formattedSummary);

  } catch (error) {
    console.error("Failed to fetch summary:", error);
    return NextResponse.json({ 
      error: "Eroare server la obținerea rezumatului" 
    }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest, 
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: summaryId } = await params;
  const userId = session.user.id;

  try {
    console.log('Attempting to delete summary:', summaryId, 'for user:', userId);

    // Verifică că rezumatul există și aparține utilizatorului
    const summary = await prisma.summary.findFirst({
      where: { 
        id: summaryId,
        userId: userId
      }
    });

    if (!summary) {
      return NextResponse.json({ 
        error: 'Rezumatul nu a fost găsit sau nu ai permisiunea să îl ștergi' 
      }, { status: 404 });
    }

    // Șterge asocierile cu cursurile mai întâi (dacă există)
    await prisma.courseSummary.deleteMany({
      where: { summaryId: summaryId }
    });

    // Apoi șterge rezumatul
    await prisma.summary.delete({
      where: { id: summaryId }
    });

    console.log('Summary deleted successfully:', summaryId);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Eroare ștergere rezumat:', error);
    return NextResponse.json({ 
      error: 'Eroare server la ștergerea rezumatului' 
    }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: summaryId } = await params;
  const userId = session.user.id;

  try {
    const { courseId, title, content } = await request.json();

    // Verifică că rezumatul există și aparține utilizatorului
    const summary = await prisma.summary.findFirst({
      where: { 
        id: summaryId,
        userId: userId
      }
    });

    if (!summary) {
      return NextResponse.json({ 
        error: 'Rezumatul nu a fost găsit sau nu ai permisiunea să îl modifici' 
      }, { status: 404 });
    }

    // Dacă se actualizează cursul
    if (courseId !== undefined) {
      // Șterge asocierile existente
      await prisma.courseSummary.deleteMany({
        where: { summaryId: summaryId }
      });

      // Adaugă noua asociere dacă courseId nu este null
      if (courseId) {
        // Verifică că cursul aparține utilizatorului
        const course = await prisma.course.findFirst({
          where: { 
            id: courseId,
            userId: userId
          }
        });

        if (!course) {
          return NextResponse.json({ 
            error: 'Cursul nu a fost găsit sau nu ai permisiunea să îl folosești' 
          }, { status: 404 });
        }

        await prisma.courseSummary.create({
          data: {
            courseId: courseId,
            summaryId: summaryId
          }
        });
      }
    }

    // Actualizează rezumatul dacă sunt furnizate title sau content
    const updateData: { title?: string; content?: string } = {};
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;

    if (Object.keys(updateData).length > 0) {
      await prisma.summary.update({
        where: { id: summaryId },
        data: updateData
      });
    }

    console.log('Summary updated successfully:', summaryId);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Eroare actualizare rezumat:', error);
    return NextResponse.json({ 
      error: 'Eroare server la actualizarea rezumatului' 
    }, { status: 500 });
  }
}