import { NextRequest } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: fileId } = await params;

  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return new Response(JSON.stringify({ error: 'Neautorizat' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    // Get user's subscription
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { subscription: true }
    });

    if (!user) {
      return new Response(JSON.stringify({ error: 'Utilizatorul nu a fost găsit' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Block downloads for free users
    if (user.subscription === 'free') {
      return new Response(JSON.stringify({ 
        error: 'Pentru a descărca rezumate, upgradează la un plan superior.' 
      }), { 
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        name: true,
        summary: true,
        userId: true
      }
    });

    if (!file) {
      return new Response(JSON.stringify({ error: 'Rezumatul nu a fost găsit' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (file.userId !== session.user.id) {
      return new Response(JSON.stringify({ error: 'Nu ai acces la acest rezumat' }), { 
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Creare fișier text
    return new Response(file.summary, {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Disposition': `attachment; filename="${file.name.replace('.pdf', '')}_rezumat.txt"`
      }
    });

  } catch (error) {
    console.error('Eroare descărcare:', error);
    return new Response(JSON.stringify({ error: 'Eroare server' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}