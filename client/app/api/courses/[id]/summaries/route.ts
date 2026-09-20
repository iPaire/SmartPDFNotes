// app/api/courses/[id]/summaries/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

// PUT - Adaugă rezumate la curs
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;
  console.log('User ID:', userId);
  console.log('Course ID:', courseId);

  try {
    const requestData = await req.json();
    const summaryIds = requestData.summaryIds;
    
    if (!Array.isArray(summaryIds)) {
      return NextResponse.json({ error: 'Date invalide' }, { status: 400 });
    }

    console.log('Requested summary IDs:', summaryIds);

    // Verifică cursul
    const courseExists = await prisma.course.findUnique({
      where: { 
        id: courseId,
        userId: userId
      }
    });
    
    if (!courseExists) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit sau nu aveți permisiune' },
        { status: 404 }
      );
    }
    
    // Verifică fiecare rezumat individual
    const validIds = [];
    const missingIds = [];
    
    for (const summaryId of summaryIds) {
      const summary = await prisma.summary.findUnique({
        where: { 
          id: summaryId,
          userId: userId
        }
      });
      
      if (summary) {
        validIds.push(summaryId);
      } else {
        missingIds.push(summaryId);
      }
    }
    
    console.log('Valid summary IDs:', validIds);
    console.log('Missing summary IDs:', missingIds);
    
    if (missingIds.length > 0) {
      return NextResponse.json({ 
        error: 'Unele rezumate nu există sau nu vă aparțin',
        missingIds: missingIds
      }, { status: 404 });
    }
    
    // Verifică care relații există deja
    const existingRelations = await prisma.courseSummary.findMany({
      where: {
        courseId: courseId,
        summaryId: {
          in: validIds
        }
      }
    });

    const existingSummaryIds = existingRelations.map(rel => rel.summaryId);
    const newSummaryIds = validIds.filter(id => !existingSummaryIds.includes(id));

    // Creează doar relațiile noi
    if (newSummaryIds.length > 0) {
      await prisma.courseSummary.createMany({
        data: newSummaryIds.map(summaryId => ({
          courseId: courseId,
          summaryId: summaryId
        })),
        skipDuplicates: true
      });
    }
    
    return NextResponse.json({ 
      success: true,
      addedCount: newSummaryIds.length,
      alreadyExisted: existingSummaryIds.length,
      total: validIds.length
    });
    
  } catch (error) {
    console.error('Error updating course summaries:', error);
    return NextResponse.json(
      { error: 'Eroare server la actualizarea rezumatelor' },
      { status: 500 }
    );
  }
}

// GET - Obține toate rezumatele unui curs
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // Verifică cursul
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      }
    });

    if (!course) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit' },
        { status: 404 }
      );
    }

    // Obține toate rezumatele cursului
    const courseSummaries = await prisma.courseSummary.findMany({
      where: {
        courseId: courseId
      },
      include: {
        summary: {
          select: {
            id: true,
            title: true,
            content: true,
            createdAt: true
          }
        }
      },
      orderBy: {
        addedAt: 'desc'
      }
    });

    const summaries = courseSummaries.map(cs => ({
      id: cs.summary.id,
      title: cs.summary.title,
      content: cs.summary.content,
      createdAt: cs.summary.createdAt,
      addedAt: cs.addedAt
    }));

    return NextResponse.json({
      summaries: summaries
    });

  } catch (error) {
    console.error('Error fetching course summaries:', error);
    return NextResponse.json(
      { error: 'Eroare server' },
      { status: 500 }
    );
  }
}

// DELETE - Elimină un rezumat din curs
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    const { summaryId } = await req.json();

    if (!summaryId) {
      return NextResponse.json({ error: 'ID-ul rezumatului este obligatoriu' }, { status: 400 });
    }

    // Verifică că cursul aparține utilizatorului
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      }
    });

    if (!course) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit' },
        { status: 404 }
      );
    }

    // Verifică că relația există
    const relation = await prisma.courseSummary.findFirst({
      where: {
        courseId: courseId,
        summaryId: summaryId
      }
    });

    if (!relation) {
      return NextResponse.json(
        { error: 'Rezumatul nu face parte din acest curs' },
        { status: 404 }
      );
    }

    // Șterge relația
    await prisma.courseSummary.delete({
      where: {
        id: relation.id
      }
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Error removing summary from course:', error);
    return NextResponse.json(
      { error: 'Eroare server' },
      { status: 500 }
    );
  }
}