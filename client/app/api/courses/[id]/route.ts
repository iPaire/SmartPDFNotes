import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

// GET - Obține detalii curs cu fișiere și rezumate
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;

  try {
    // Găsește cursul împreună cu relațiile sale
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: session.user.id
      },
      include: {
        files: {
          select: {
            id: true,
            name: true,
            createdAt: true
          }
        },
        summaries: {
          select: {
            id: true,
            summaryId: true,
            addedAt: true,
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
        }
      }
    });

    if (!course) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit sau nu aveți permisiune' },
        { status: 404 }
      );
    }

    // Transformă datele pentru frontend
    const courseData = {
      id: course.id,
      title: course.title,
      description: course.description,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
      files: course.files,
      summaries: course.summaries.map(cs => ({
        id: cs.summary.id,
        title: cs.summary.title,
        content: cs.summary.content,
        createdAt: cs.summary.createdAt,
        addedAt: cs.addedAt
      }))
    };

    return NextResponse.json({ course: courseData });

  } catch (error) {
    console.error('Error fetching course:', error);
    return NextResponse.json(
      { error: 'Eroare server la încărcarea cursului' },
      { status: 500 }
    );
  }
}

// PUT - Actualizează cursul (titlu, descriere)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;

  try {
    const { title, description } = await req.json();

    if (!title || title.trim() === '') {
      return NextResponse.json({ error: 'Titlul este obligatoriu' }, { status: 400 });
    }

    // Verifică dacă cursul aparține utilizatorului
    const existingCourse = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: session.user.id
      }
    });

    if (!existingCourse) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit sau nu aveți permisiune' },
        { status: 404 }
      );
    }

    // Actualizează cursul
    const updatedCourse = await prisma.course.update({
      where: { id: courseId },
      data: {
        title: title.trim(),
        description: description?.trim() || null,
        updatedAt: new Date()
      }
    });

    return NextResponse.json({ 
      success: true,
      course: updatedCourse
    });

  } catch (error) {
    console.error('Error updating course:', error);
    return NextResponse.json(
      { error: 'Eroare server la actualizarea cursului' },
      { status: 500 }
    );
  }
}

// DELETE - Șterge cursul
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;

  try {
    // Verifică dacă cursul aparține utilizatorului
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: session.user.id
      }
    });

    if (!course) {
      return NextResponse.json(
        { error: 'Cursul nu a fost găsit sau nu aveți permisiune' },
        { status: 404 }
      );
    }

    // Șterge cursul (relațiile vor fi șterse automat datorită cascadei)
    await prisma.course.delete({
      where: { id: courseId }
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Error deleting course:', error);
    return NextResponse.json(
      { error: 'Eroare server la ștergerea cursului' },
      { status: 500 }
    );
  }
}