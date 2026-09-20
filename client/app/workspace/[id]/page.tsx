// app/workspace/[id]/page.tsx - Learning workspace for a single document.
// Server component: loads the summary (owner-scoped) plus lightweight
// metadata. extractedText is never selected here - it stays server-side and
// is only read by the generation/chat API routes.
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/authOptions';
import prisma from '@/lib/prisma';
import { createDiagramViewUrls } from '@/lib/supabase-storage';
import { redirect } from 'next/navigation';
import WorkspaceShell, { WorkspaceData, WorkspaceQuizQuestion } from '@/components/workspace/WorkspaceShell';

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect('/login');
  }

  const summary = await prisma.summary.findFirst({
    where: { id, userId: session.user.id },
    include: {
      file: {
        select: { id: true, name: true, pages: true, characters: true, quiz: true, language: true },
      },
      artifacts: {
        select: { type: true, updatedAt: true },
      },
      _count: { select: { chatMessages: true } },
    },
  });

  if (!summary) {
    redirect('/summaries');
  }

  // Whether full document text exists (legacy rows predate text persistence).
  const hasDocumentText = summary.fileId
    ? (await prisma.file.count({
        where: { id: summary.fileId, extractedText: { not: null } },
      })) > 0
    : false;

  // Plan comes from the DB, not the session: the session JWT is built by a
  // config that never sets `subscription`, so it is always undefined here.
  const dbUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscription: true },
  });

  // Diagram pages extracted from the document (rendered post-upload).
  // Signed per view: the bucket is private.
  let diagrams: { page: number; url: string }[] = [];
  if (summary.artifacts.some((a) => a.type === 'diagrams')) {
    const diagramsArtifact = await prisma.workspaceArtifact.findUnique({
      where: { summaryId_type: { summaryId: summary.id, type: 'diagrams' } },
      select: { content: true },
    });
    const refs = (diagramsArtifact?.content as { pages?: unknown } | null)?.pages as
      | { page: number; path: string }[]
      | undefined;
    if (Array.isArray(refs) && refs.length > 0) {
      const urls = await createDiagramViewUrls(refs.map((r) => r.path));
      diagrams = refs
        .map((r, i) => ({ page: r.page, url: urls[i] }))
        .filter((d): d is { page: number; url: string } => !!d.url);
    }
  }

  const data: WorkspaceData = {
    id: summary.id,
    title: summary.title,
    content: summary.content,
    language: summary.language,
    createdAt: summary.createdAt.toISOString(),
    fileName: summary.file?.name ?? null,
    pages: summary.file?.pages ?? null,
    uploadQuiz: (summary.file?.quiz as WorkspaceQuizQuestion[] | null) ?? null,
    hasDocumentText,
    artifacts: summary.artifacts.map((a) => ({ type: a.type, updatedAt: a.updatedAt.toISOString() })),
    chatCount: summary._count.chatMessages,
    plan: dbUser?.subscription || 'free',
    diagrams,
  };

  return <WorkspaceShell data={data} />;
}
