// app/api/upload-url/route.ts - Issues a signed Supabase Storage URL so the
// browser can upload large PDFs directly (Vercel caps function request
// bodies at 4.5MB). The path is keyed under the user's id; /api/summarize
// verifies that prefix before downloading.
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/authOptions';
import prisma from '@/lib/prisma';
import { createSignedUpload, storageConfigured } from '@/lib/supabase-storage';

// Per-plan upload size limits in MB (mirrors /api/usage).
const SIZE_LIMITS_MB: Record<string, number> = {
  free: 10,
  trial: 25,
  standard: 50,
  premium: 50,
};

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!storageConfigured()) {
    return NextResponse.json(
      { error: 'Large file uploads are not available right now. Please try a file under 4MB.' },
      { status: 503 }
    );
  }

  let body: { filename?: string; size?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const size = Number(body.size);
  if (!body.filename || !Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: 'filename and size are required' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscription: true },
  });
  const limitMb = SIZE_LIMITS_MB[user?.subscription || 'free'] ?? 10;
  if (size > limitMb * 1024 * 1024) {
    return NextResponse.json(
      { error: `File exceeds your plan's ${limitMb}MB limit` },
      { status: 400 }
    );
  }

  try {
    const path = `${session.user.id}/${randomUUID()}.pdf`;
    const { signedUrl } = await createSignedUpload(path);
    return NextResponse.json({ path, signedUrl });
  } catch (error) {
    console.error('[upload-url] failed to create signed upload:', error);
    return NextResponse.json({ error: 'Could not prepare the upload. Please try again.' }, { status: 502 });
  }
}
