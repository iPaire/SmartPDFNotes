// app/api/summaries/[id]/download/route.ts
import { NextRequest } from 'next/server';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: fileId } = await params;
  
  console.log('Download request for ID:', fileId);

  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    console.log('No session found');
    return new Response(JSON.stringify({ error: 'Neautorizat' }), { 
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  console.log('User:', session.user.id, 'Subscription:', session.user.subscription);

  // Verificăm dacă utilizatorul este gratuit
  if (session.user.subscription === 'free') {
    console.log('Free user attempting download');
    return new Response(JSON.stringify({ error: 'Utilizatorii gratuit nu pot descărca rezumate' }), { 
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    console.log('Searching for record with ID:', fileId);
    
    // Încearcă să găsești în tabela File mai întâi
    let record: { id: string; name: string; summary: string; userId: string } | null = await prisma.file.findUnique({
      where: { id: fileId },
      select: {
        id: true,
        name: true,
        summary: true,
        userId: true
      }
    });

    console.log('File record found:', !!record);

    // Dacă nu găsești în File, încearcă în Summary
    if (!record) {
      console.log('Trying Summary table...');
      const summaryRecord = await prisma.summary.findUnique({
        where: { id: fileId },
        select: {
          id: true,
          title: true,
          content: true,
          userId: true
        }
      });
      
      console.log('Summary record found:', !!summaryRecord);
      
      // Adaptăm structura pentru a fi compatibilă
      if (summaryRecord) {
        record = {
          id: summaryRecord.id,
          userId: summaryRecord.userId,
          name: summaryRecord.title,
          summary: summaryRecord.content
        };
      }
    }

    if (!record) {
      console.log('No record found in either table');
      return new Response(JSON.stringify({ error: 'Rezumatul nu a fost găsit' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Record owner:', record.userId, 'Current user:', session.user.id);

    // Verificăm dacă utilizatorul are dreptul de acces la rezumat
    if (record.userId !== session.user.id) {
      console.log('Access denied - user mismatch');
      return new Response(JSON.stringify({ error: 'Nu ai acces la acest rezumat' }), { 
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!record.summary) {
      console.log('No summary content available');
      return new Response(JSON.stringify({ error: 'Rezumatul nu este disponibil' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('Download successful for:', record.name);

    // Creare fișier text pentru descărcare
    const fileName = record.name ? record.name.replace('.pdf', '') : 'rezumat';
    
    return new Response(record.summary, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}_rezumat.txt"`,
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
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