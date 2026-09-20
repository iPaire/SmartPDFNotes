import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { id: quizId } = await params;

  try {
    // Mai întâi verificăm dacă este un quiz din tabela Quiz
    const quiz = await prisma.quiz.findFirst({
      where: {
        id: quizId,
        userId: session.user.id
      },
      include: {
        course: {
          select: {
            title: true
          }
        }
      }
    });

    if (quiz) {
      return new Response(JSON.stringify({
        quiz: quiz.questions,
        fileName: `Quiz - ${quiz.course.title}`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Dacă nu, verificăm în sistemul vechi (File)
    const file = await prisma.file.findUnique({
      where: {
        id: quizId,
        userId: session.user.id
      }
    });

    if (!file || !file.quiz) {
      return new Response(JSON.stringify({ error: 'Testul nu a fost găsit' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      quiz: file.quiz,
      fileName: file.name
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error fetching quiz:', error);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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

  const { id: quizId } = await params;
  const userId = session.user.id;

  try {
    console.log('Attempting to delete quiz:', quizId, 'for user:', userId);

    // Mai întâi verificăm dacă este un quiz din tabela Quiz (sistemul nou)
    const quiz = await prisma.quiz.findFirst({
      where: {
        id: quizId,
        userId: userId
      }
    });

    if (quiz) {
      // Șterge quiz-ul din tabela Quiz
      await prisma.quiz.delete({
        where: { id: quizId }
      });

      console.log('Quiz deleted successfully from Quiz table:', quizId);
      return NextResponse.json({ success: true });
    }

    // Dacă nu e în Quiz, verificăm în File (sistemul vechi)
    const file = await prisma.file.findFirst({
      where: {
        id: quizId,
        userId: userId
      }
    });

    if (!file) {
      return NextResponse.json({
        error: 'Quiz-ul nu a fost găsit sau nu ai permisiunea să îl ștergi'
      }, { status: 404 });
    }

    // Șterge fișierul (care conține quiz-ul)
    await prisma.file.delete({
      where: { id: quizId }
    });

    console.log('Quiz deleted successfully from File table:', quizId);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error('Eroare ștergere quiz:', error);
    return NextResponse.json({
      error: 'Eroare server la ștergerea quiz-ului'
    }, { status: 500 });
  }
}