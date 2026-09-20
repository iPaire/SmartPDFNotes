import { getServerSession } from "next-auth/next"
import { authOptions } from "@/lib/authOptions"
import prisma from "@/lib/prisma"
import { Prisma } from '@prisma/client';

export async function GET() {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const files = await prisma.file.findMany({
      where: { 
        userId: session.user.id,
        quiz: { not: Prisma.DbNull } // Verificare corectă pentru JSON null
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        quiz: true
      },
      orderBy: { createdAt: 'desc' }
    });

    const formattedFiles = files.map(file => ({
      id: file.id,
      name: file.name,
      createdAt: file.createdAt.toISOString(),
      quizCount: file.quiz ? (file.quiz as unknown[]).length : 0
    }));

    return new Response(JSON.stringify(formattedFiles), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: 'Server error' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}