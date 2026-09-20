'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { 
  Folder, Plus, FileText, Copy, BookOpen, File, CheckSquare, Clipboard, 
  Search, Trash2, Edit, ChevronDown, ChevronUp, Printer, RefreshCw, 
  Loader, Download, X, CheckCircle, XCircle
} from 'react-feather';
import { useTranslations, useLocale } from 'next-intl';
import { analyticsEvents } from '@/lib/analytics';

type Summary = {
  id: string;
  title?: string;
  name?: string;
  content: string;
  createdAt: string;
  courses: { id: string }[];
  file?: {
    name: string;
  };
  addedAt?: string;
};

type Course = {
  id: string;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  summaries: Summary[];
  files: CourseFile[];
};

type FinalSummary = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  addedAt: string;
};

type CheatSheet = {
  id: string;
  content: string;
  createdAt: string;
};

type CourseFile = {
  id: string;
  name: string;
  createdAt: string;
};

type QuizQuestion = {
  question: string;
  options: string[];
};

type QuizResult = {
  question: string;
  options: string[];
  userAnswer: number;
  correctAnswer: number;
  isCorrect: boolean;
  explanation?: string;
};

type QuizResults = {
  results: QuizResult[];
  summary: {
    correctAnswers: number;
    totalQuestions: number;
    percentage: number;
    grade: string;
    feedback: string;
  };
};

type Quiz = {
  id: string;
  content: QuizQuestion[];
  createdAt: string;
};

export default function CoursePage() {
  const t = useTranslations('courseDetail');
  const tCommon = useTranslations('common');
  const tWorkspace = useTranslations('workspace');
  const locale = useLocale();
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const courseId = params.id as string;
  
  // Course states
  const [course, setCourse] = useState<Course | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Generation states
  const [fullSummary, setFullSummary] = useState('');
  const [generating, setGenerating] = useState({
    summary: false,
    cheatSheet: false,
    quiz: false,
  });
  const [copied, setCopied] = useState({
    fullSummary: false
  });
  const [copiedSummaryId, setCopiedSummaryId] = useState<string | null>(null);
  
  // Modal states
  const [showAddSummaries, setShowAddSummaries] = useState(false);
  const [showEditCourse, setShowEditCourse] = useState(false);
  
  // Form states
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  
  // Summary selection
  const [availableSummaries, setAvailableSummaries] = useState<Summary[]>([]);
  const [selectedSummaryIds, setSelectedSummaryIds] = useState<string[]>([]);
  const [isLoadingSummaries, setIsLoadingSummaries] = useState(false);

  // Final summary state
  const [finalSummary, setFinalSummary] = useState<FinalSummary | null>(null);
  
  // Cheat sheets and quizzes
  const [cheatSheets, setCheatSheets] = useState<CheatSheet[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [activeCheatSheet, setActiveCheatSheet] = useState<string | null>(null);
  const [activeQuiz, setActiveQuiz] = useState<string | null>(null);
  
  // Success messages
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  
  // Expandable sections
  const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set());
  const [activeMaterialTab, setActiveMaterialTab] = useState<'summary' | 'cheatsheet' | 'quiz'>('summary');

  // Quiz states
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number[]>>({});
  const [quizResults, setQuizResults] = useState<QuizResults | null>(null);
  const [isSubmittingQuiz, setIsSubmittingQuiz] = useState(false);

  // Helper function to get summary display name
  const getSummaryName = (summary: Summary) => {
    if (summary.name) return summary.name;
    if (summary.file?.name) return summary.file.name;
    if (summary.title) return summary.title;
    
    const date = new Date(summary.createdAt).toLocaleDateString(locale);
    return `${tCommon('summaries')} ${date}`;
  };

  // Toggle summary expansion
  const toggleSummary = (summaryId: string) => {
    setExpandedSummaries(prev => {
      const newSet = new Set(prev);
      if (newSet.has(summaryId)) {
        newSet.delete(summaryId);
      } else {
        newSet.add(summaryId);
      }
      return newSet;
    });
  };

  // Fetch course data
  const fetchCourse = async () => {
    try {
      setError(null);
      const response = await fetch(`/api/courses/${courseId}`);
      
      if (!response.ok) {
        throw new Error(t('errorLoadingCourse'));
      }

      const data = await response.json();
      const courseData = data.course || null;
      setCourse(courseData);
      
      // Set form data for editing
      if (courseData) {
        setEditTitle(courseData.title || '');
        setEditDescription(courseData.description || '');
      }
      
      return courseData;
    } catch (error) {
      console.error('Error fetching course:', error);
      setError(error instanceof Error ? error.message : t('unknownError'));
      return null;
    }
  };

  // Fetch available summaries
  const fetchAvailableSummaries = async () => {
    try {
      setIsLoadingSummaries(true);
      const response = await fetch('/api/summaries');
      
      if (response.ok) {
        const data = await response.json();
        setAvailableSummaries(data.summaries || []);
      }
    } catch (error) {
      console.error('Error fetching summaries:', error);
    } finally {
      setIsLoadingSummaries(false);
    }
  };

  // Fetch final summary for course
  const fetchFinalSummary = async () => {
    try {
      const response = await fetch(`/api/courses/${courseId}/final-summary`);
      
      if (response.ok) {
        const data = await response.json();
        if (data.finalSummary) {
          setFinalSummary(data.finalSummary);
          setFullSummary(data.finalSummary.content);
        } else {
          setFinalSummary(null);
        }
      }
    } catch (error) {
      console.error('Error fetching final summary:', error);
    }
  };

  // Fetch cheat sheets for course
  const fetchCheatSheets = async () => {
    try {
      const response = await fetch(`/api/courses/${courseId}/cheat-sheet`);
      
      if (response.ok) {
        const data = await response.json();
        const cheatSheets = data?.cheatSheets || [];
        setCheatSheets(cheatSheets);
        if (cheatSheets.length > 0) {
          setActiveCheatSheet(cheatSheets[0].id);
        }
      } else {
        console.error('Failed to fetch cheat sheets:', response.status, response.statusText);
        setCheatSheets([]);
      }
    } catch (error) {
      console.error('Error fetching cheat sheets:', error);
      setCheatSheets([]);
    }
  };

  // Fetch quizzes for course
  const fetchQuizzes = async () => {
    try {
      const response = await fetch(`/api/courses/${courseId}/quiz`);
      
      if (response.ok) {
        const data = await response.json();
        const quizzes = data?.quizzes || [];
        setQuizzes(quizzes);
        if (quizzes.length > 0) {
          setActiveQuiz(quizzes[0].id);
        }
      } else {
        console.error('Failed to fetch quizzes:', response.status, response.statusText);
        setQuizzes([]);
      }
    } catch (error) {
      console.error('Error fetching quizzes:', error);
      setQuizzes([]);
    }
  };

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
      return;
    }

    if (status === 'authenticated' && courseId) {
      const loadData = async () => {
        await fetchCourse();
        await fetchFinalSummary();
        await fetchCheatSheets();
        await fetchQuizzes();
        setLoading(false);
      };
      loadData();
    }
  }, [status, courseId]);

  // Load summaries when modal opens
  useEffect(() => {
    if (showAddSummaries && status === 'authenticated') {
      fetchAvailableSummaries();
    }
  }, [showAddSummaries, status]);

  // Add selected summaries to course
  const addSelectedSummaryIds = async () => {
    if (selectedSummaryIds.length === 0) {
      alert(t('selectAtLeastOneSummary'));
      return;
    }

    try {
      const response = await fetch(`/api/courses/${courseId}/summaries`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaryIds: selectedSummaryIds }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t('errorAddingSummaries'));
      }

      // Refresh course data
      await fetchCourse();
      await fetchFinalSummary();
      
      // Close modal and reset selection
      setShowAddSummaries(false);
      setSelectedSummaryIds([]);
      
      // Show success message
      setSuccessMessage(t('summaryAddedSuccessfully'));
      setTimeout(() => setSuccessMessage(null), 5000);
    } catch (error) {
      console.error('Error adding summaries:', error);
      const errorMessage = error instanceof Error ? error.message : t('unknownError');
      alert(`${tCommon('error')}: ${errorMessage}`);
    }
  };

  // Remove summary from course
  const removeSummaryFromCourse = async (summaryId: string) => {
    if (!confirm(t('removeSummaryConfirm'))) {
      return;
    }

    try {
      const response = await fetch(`/api/courses/${courseId}/summaries`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaryId }),
      });

      if (response.ok) {
        // Refresh course data
        await fetchCourse();
        await fetchFinalSummary();
        // Show success message
        setSuccessMessage(t('summaryRemovedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error removing summary:', error);
      alert(t('errorRemovingSummary'));
    }
  };

  // Delete cheat sheet
  const deleteCheatSheet = async (cheatSheetId: string) => {
    if (!confirm(t('deleteCheatSheetConfirm'))) {
      return;
    }

    try {
      const response = await fetch(`/api/courses/${courseId}/cheat-sheet`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cheatSheetId }),
      });

      if (response.ok) {
        await fetchCheatSheets();
        setSuccessMessage(t('cheatSheetDeletedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error deleting cheat sheet:', error);
      alert(t('errorDeletingCheatSheet'));
    }
  };

  // Delete quiz
  const deleteQuiz = async (quizId: string) => {
    if (!confirm(t('deleteQuizConfirm'))) {
      return;
    }

    try {
      const response = await fetch(`/api/courses/${courseId}/quiz`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId }),
      });

      if (response.ok) {
        await fetchQuizzes();
        setSuccessMessage(t('quizDeletedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error deleting quiz:', error);
      alert(t('errorDeletingQuiz'));
    }
  };

  // Update course details
  const updateCourse = async () => {
    if (!editTitle.trim()) {
      alert(t('titleRequired'));
      return;
    }

    try {
      const response = await fetch(`/api/courses/${courseId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim(),
        }),
      });

      if (response.ok) {
        setShowEditCourse(false);
        await fetchCourse();
        // Show success message
        setSuccessMessage(t('courseUpdatedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error updating course:', error);
      alert(t('errorUpdatingCourse'));
    }
  };

  // Generate final summary
  const generateFinalSummary = async () => {
    if (!course?.summaries || course.summaries.length === 0) {
      alert(t('noSummariesInCourse'));
      return;
    }

    setGenerating(prev => ({...prev, summary: true}));
    try {
      const res = await fetch(`/api/courses/${courseId}/final-summary`, { 
        method: 'POST' 
      });
      
      if (res.ok) {
        const data = await res.json();
        setFullSummary(data.finalSummary.content);
        setFinalSummary(data.finalSummary);
        
        // Show success message
        setSuccessMessage(t('finalSummaryGeneratedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error generating summary:', error);
      alert(t('errorGeneratingFinalSummary'));
    } finally {
      setGenerating(prev => ({...prev, summary: false}));
    }
  };

  const generateCheatSheet = async () => {
    if (!course?.summaries || course.summaries.length === 0) {
      alert(t('noSummariesInCourse'));
      return;
    }

    setGenerating(prev => ({...prev, cheatSheet: true}));
    try {
      const res = await fetch(`/api/courses/${courseId}/cheat-sheet`, { 
        method: 'POST' 
      });
      
      if (res.ok) {
        await fetchCheatSheets();
        // Show success message
        setSuccessMessage(t('cheatSheetGeneratedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error generating cheat sheet:', error);
      alert(t('errorGeneratingCheatSheet'));
    } finally {
      setGenerating(prev => ({...prev, cheatSheet: false}));
    }
  };

  const generateQuiz = async () => {
    if (!course?.summaries || course.summaries.length === 0) {
      alert(t('noSummariesInCourse'));
      return;
    }

    // Track quiz generation attempt
    analyticsEvents.buttonClick('generate_quiz', 'course_page');
    analyticsEvents.quizGenerated(course.summaries.length);

    setGenerating(prev => ({...prev, quiz: true}));
    try {
      const res = await fetch(`/api/courses/${courseId}/quiz`, { 
        method: 'POST' 
      });
      
      if (res.ok) {
        await fetchQuizzes();
        // Show success message
        setSuccessMessage(t('quizGeneratedSuccessfully'));
        setTimeout(() => setSuccessMessage(null), 5000);
      }
    } catch (error) {
      console.error('Error generating quiz:', error);
      alert(t('errorGeneratingQuiz'));
    } finally {
      setGenerating(prev => ({...prev, quiz: false}));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(prev => ({...prev, fullSummary: true }));
    setTimeout(() => setCopied(prev => ({...prev, fullSummary: false })), 2000);
  };

  const copySummary = (content: string, id: string) => {
    navigator.clipboard.writeText(content);
    setCopiedSummaryId(id);
    setTimeout(() => setCopiedSummaryId(null), 2000);
  };

  const handlePrintCheatSheet = () => {
    if (!activeCheatSheet) return;
    
    const activeCheatSheetData = cheatSheets.find(cs => cs.id === activeCheatSheet);
    if (!activeCheatSheetData) return;

    // Create a new window for printing
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    // Write the cheat sheet content directly (it's already formatted HTML)
     printWindow.document.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${t('cheatSheet')} - ${course?.title || ''}</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 100%;
            padding: 20px;
          }
          @media print {
            body {
              padding: 0;
              margin: 0;
            }
          }
        </style>
      </head>
      <body>
        ${activeCheatSheetData.content}
      </body>
    </html>
  `);
  
  printWindow.document.close();
    
    // Wait for content to load then print
    printWindow.onload = () => {
      printWindow.print();
    };
  };

  const downloadCheatSheetHTML = () => {
    if (!activeCheatSheet) return;
    
    const activeCheatSheetData = cheatSheets.find(cs => cs.id === activeCheatSheet);
    if (!activeCheatSheetData || !course) return;

    const blob = new Blob([activeCheatSheetData.content], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('cheatSheet').toLowerCase()}-${course.title.toLowerCase().replace(/\s+/g, '-')}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Quiz functionality
  const handleAnswerSelect = (quizId: string, questionIndex: number, optionIndex: number) => {
    setSelectedAnswers(prev => {
      const currentQuizAnswers = prev[quizId] || [];
      const newAnswers = [...currentQuizAnswers];
      newAnswers[questionIndex] = optionIndex;
      return {
        ...prev,
        [quizId]: newAnswers
      };
    });
  };

  const submitQuiz = async () => {
    if (!activeQuiz) return;
    
    // Track quiz submission
    analyticsEvents.buttonClick('submit_quiz', 'course_page');
    analyticsEvents.quizStarted();
    
    setIsSubmittingQuiz(true);
    
    try {
      const answers = selectedAnswers[activeQuiz] || [];
      
      const response = await fetch(`/api/courses/${courseId}/quiz`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          quizId: activeQuiz, 
          answers: answers
        }),
      });

      if (response.ok) {
        const result = await response.json();
        setQuizResults(result);
        
        // Track quiz completion with score
        if (result.summary?.percentage) {
          analyticsEvents.quizCompleted(result.summary.percentage);
        }
      } else {
        throw new Error(t('errorSubmittingAnswers'));
      }
    } catch (error) {
      console.error('Error submitting quiz:', error);
      alert(t('errorSubmittingAnswers'));
    } finally {
      setIsSubmittingQuiz(false);
    }
  };

  const restartQuiz = () => {
    setQuizResults(null);
    setSelectedAnswers(prev => ({
      ...prev,
      [activeQuiz!]: []
    }));
  };

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-ink-soft">{t('loadingCourse')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="text-center max-w-md p-8 bg-surface border border-line rounded-card shadow-card">
          <Folder className="mx-auto h-16 w-16 text-red-500" />
          <h3 className="mt-4 text-xl font-bold text-ink">{tCommon('error')}</h3>
          <p className="mt-2 text-ink-soft">{error}</p>
          <button
            onClick={() => {
              setError(null);
              fetchCourse();
            }}
            className="mt-6 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            {t('tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="text-center max-w-md p-8 bg-surface border border-line rounded-card shadow-card">
          <Folder className="mx-auto h-16 w-16 text-ink-faint" />
          <h3 className="mt-4 text-xl font-bold text-ink">{t('courseNotFound')}</h3>
          <p className="mt-2 text-ink-soft">
            {t('authRequired')}
          </p>
          <button
            onClick={() => router.push('/courses')}
            className="mt-6 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            {t('backToCourses')}
          </button>
        </div>
      </div>
    );
  }

  const hasSummaries = course.summaries?.length > 0;
  const hasContent = course.files?.length > 0 || 
                    course.summaries?.length > 0 || 
                    fullSummary || 
                    cheatSheets.length > 0 || 
                    quizzes.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Success Message Banner */}
      {successMessage && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50">
          <div className="bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg flex items-center">
            <CheckSquare className="mr-2" />
            <span>{successMessage}</span>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8 bg-white rounded-2xl shadow-lg p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-ink">{course.title}</h1>
              {course.description && (
                <p className="mt-2 text-ink-soft max-w-3xl">{course.description}</p>
              )}
              <div className="mt-3 text-sm text-ink-faint">
                {t('createdAt')}: {new Date(course.createdAt).toLocaleDateString(locale)}
                {course.updatedAt !== course.createdAt && (
                  <span className="ml-3">
                    • {t('updatedAt')}: {new Date(course.updatedAt).toLocaleDateString(locale)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex space-x-2">
              <button
                onClick={() => setShowEditCourse(true)}
                className="px-4 py-2 flex items-center gap-2 bg-white border border-line-strong rounded-lg text-ink-soft hover:bg-sunken"
              >
                <Edit className="h-4 w-4" />
                {tCommon('edit')}
              </button>
              <button
                onClick={() => router.push('/courses')}
                className="px-4 py-2 border border-line-strong rounded-lg text-ink-soft hover:bg-sunken"
              >
                {t('back')}
              </button>
            </div>
          </div>
        </div>

        {/* Summary Management Section */}
        <div className="mb-8 bg-white rounded-2xl shadow-lg p-6">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-3">
              <BookOpen className="h-6 w-6 text-indigo-600" />
              <h2 className="text-xl font-bold text-ink">{t('courseSummaries')}</h2>
            </div>
            <div className="flex space-x-2">
              {course.summaries.length > 1 && (
                <button
                  onClick={generateFinalSummary}
                  disabled={generating.summary}
                  className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 ${
                    generating.summary
                      ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                      : 'bg-purple-600 hover:bg-purple-700 text-white shadow-md'
                  }`}
                >
                  {generating.summary ? (
                    <>
                      <Loader  className="mr-2 h-4 w-4 animate-spin" />
                      {t('generating')}
                    </>
                  ) : (
                    <>
                      <BookOpen className="h-5 w-5" />
                      {t('finalSummary')}
                    </>
                  )}
                </button>
              )}
              <button
                onClick={() => setShowAddSummaries(true)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg flex items-center gap-2 shadow-md"
              >
                <Plus className="h-5 w-5" />
                {t('addSummaries')}
              </button>
            </div>
          </div>
          
          <div className="mb-6">
            <h3 className="font-medium text-ink-soft mb-3">{t('addedSummaries', { count: course.summaries.length })}</h3>
            {course.summaries.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {course.summaries.map(summary => {
                  const isExpanded = expandedSummaries.has(summary.id);
                  return (
                    <div 
                      key={summary.id}
                      className="border rounded-xl p-5 hover:shadow-md transition-shadow bg-gradient-to-br from-indigo-50 to-indigo-100"
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex items-center gap-2 flex-1">
                          <div className="p-2 bg-indigo-100 rounded-lg">
                            <BookOpen className="h-5 w-5 text-indigo-600" />
                          </div>
                          <div className="flex-1">
                            <h3 className="font-semibold text-ink">
                              {getSummaryName(summary)}
                            </h3>
                            <p className="text-xs text-ink-faint">
                              {t('createdAt')}: {new Date(summary.createdAt).toLocaleDateString(locale)}
                              {summary.addedAt && (
                                <span className="ml-2">
                                  • {t('addedOn')}: {new Date(summary.addedAt).toLocaleDateString(locale)}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 items-center">
                          <Link
                            href={`/workspace/${summary.id}`}
                            className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent-strong whitespace-nowrap"
                          >
                            <BookOpen className="h-3.5 w-3.5" />
                            {tWorkspace('openWorkspace')}
                          </Link>
                          <button
                            onClick={() => copySummary(summary.content, summary.id)}
                            className="text-ink-faint hover:text-indigo-600"
                          >
                            {copiedSummaryId === summary.id ? (
                              <span className="text-sm text-indigo-600 font-medium">{t('copied')}</span>
                            ) : (
                              <Clipboard className="h-5 w-5" />
                            )}
                          </button>
                          <button 
                            onClick={() => toggleSummary(summary.id)}
                            className="text-ink-faint hover:text-indigo-600"
                          >
                            {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                          </button>
                          <button 
                            onClick={() => removeSummaryFromCourse(summary.id)}
                            className="text-ink-faint hover:text-red-600"
                          >
                            <Trash2 className="h-5 w-5" />
                          </button>
                        </div>
                      </div>
                      
                      {isExpanded && (
                        <div className="mt-4">
                          <div className="bg-sunken border border-line rounded-xl p-5 max-h-[500px] overflow-y-auto">
                            <p className="whitespace-pre-line text-ink-soft">{summary.content}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-ink-faint">
                <p>{t('noSummariesInCourse')}</p>
                <button
                  onClick={() => setShowAddSummaries(true)}
                  className="mt-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                >
                  {t('addFirstSummary')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Course Materials Section */}
        <div className="mb-8 bg-white rounded-2xl shadow-lg p-6">
          <div className="flex items-center gap-3 mb-6">
            <Folder className="h-6 w-6 text-indigo-600" />
            <h2 className="text-xl font-bold text-ink">{t('courseMaterials')}</h2>
          </div>

          {/* Material Tabs */}
          <div className="flex border-b border-line mb-6">
            <button
              onClick={() => setActiveMaterialTab('summary')}
              className={`px-4 py-2 font-medium ${
                activeMaterialTab === 'summary'
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {t('finalSummary')}
            </button>
            <button
              onClick={() => setActiveMaterialTab('cheatsheet')}
              className={`px-4 py-2 font-medium ${
                activeMaterialTab === 'cheatsheet'
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {t('cheatSheet')}
            </button>
            <button
              onClick={() => setActiveMaterialTab('quiz')}
              className={`px-4 py-2 font-medium ${
                activeMaterialTab === 'quiz'
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-ink-faint hover:text-ink-soft'
              }`}
            >
              {t('quiz')}
            </button>
          </div>

          {/* Material Content */}
          <div className="min-h-[300px]">
            {/* Final Summary Tab */}
            {activeMaterialTab === 'summary' && (
              <div>
                {finalSummary ? (
                  <div>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
                      <div className="flex items-center gap-3">
                        <BookOpen className="h-6 w-6 text-indigo-600" />
                        <div>
                          <h3 className="text-lg font-bold text-ink">{t('finalSummaryGenerated')}</h3>
                          <p className="text-sm text-ink-faint">
                            {t('createdAt')}: {new Date(finalSummary.createdAt).toLocaleDateString(locale)}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => copyToClipboard(fullSummary)}
                        className="px-4 py-2 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded-lg flex items-center gap-2"
                      >
                        <Copy className="h-4 w-4" />
                        {copied.fullSummary ? t('copied') : t('copy')}
                      </button>
                    </div>
                    <div className="bg-sunken border border-line rounded-xl p-5 max-h-[500px] overflow-y-auto">
                      <p className="whitespace-pre-line text-ink-soft">{fullSummary}</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <BookOpen className="mx-auto h-12 w-12 text-ink-faint" />
                    <h3 className="mt-4 text-lg font-bold text-ink">{t('noFinalSummaryGenerated')}</h3>
                    <p className="mt-2 text-ink-soft">
                      {t('generateFinalSummaryDescription')}
                    </p>
                    <button
                      onClick={generateFinalSummary}
                      disabled={!hasSummaries || generating.summary}
                      className={`mt-4 px-4 py-2 rounded-lg font-medium flex items-center gap-2 mx-auto ${
                        !hasSummaries || generating.summary
                          ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-700 text-white shadow-md'
                      }`}
                    >
                      {generating.summary ? (
                        <>
                          <Loader  className="h-5 w-5 animate-spin" />
                          {t('generating')}
                        </>
                      ) : (
                        <>
                          <BookOpen className="h-5 w-5" />
                          {t('generateFinalSummary')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Cheat Sheet Tab */}
            {activeMaterialTab === 'cheatsheet' && (
              <div>
                {cheatSheets.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2 mb-4">
                      {cheatSheets.map((cs) => (
                      <div
                        key={cs.id}
                        className={`px-3 py-1 text-sm rounded-lg flex items-center justify-between ${
                          activeCheatSheet === cs.id
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-200 hover:bg-gray-300'
                        }`}
                      >
                        <button
                          onClick={() => setActiveCheatSheet(cs.id)}
                          className="flex-1 text-left"
                        >
                          {new Date(cs.createdAt).toLocaleDateString(locale)}
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCheatSheet(cs.id);
                          }}
                          className="ml-2 text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    </div>
                    
                    {activeCheatSheet && (
                      <div className="print-container">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
                          <div className="flex items-center gap-3">
                            <File className="h-6 w-6 text-green-600" />
                            <h3 className="text-lg font-bold text-ink">{t('synthesisSheet')}</h3>
                            <span className="text-sm text-ink-faint">
                              {new Date(
                                cheatSheets.find(cs => cs.id === activeCheatSheet)?.createdAt || ''
                              ).toLocaleDateString(locale)}
                            </span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={generateCheatSheet}
                              disabled={generating.cheatSheet}
                              className="px-4 py-2 bg-green-100 hover:bg-green-200 text-green-700 rounded-lg flex items-center gap-2"
                            >
                              {generating.cheatSheet ? (
                                <Loader className="h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="h-4 w-4" />
                              )}
                              {t('regenerate')}
                            </button>
                            <button
                              onClick={handlePrintCheatSheet}
                              className="px-4 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg flex items-center gap-2"
                            >
                              <Printer className="h-4 w-4" />
                              {t('print')}
                            </button>
                            <button
                              onClick={downloadCheatSheetHTML}
                              className="px-4 py-2 bg-purple-100 hover:bg-purple-200 text-purple-700 rounded-lg flex items-center gap-2"
                            >
                              <Download className="h-4 w-4" />
                              {tCommon('download')}
                            </button>
                          </div>
                        </div>
                        <div className="cheat-sheet-isolated-container">
                          <iframe
                            srcDoc={cheatSheets.find(cs => cs.id === activeCheatSheet)?.content || ''}
                            className="cheat-sheet-iframe"
                            title={t('cheatSheet')}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <File className="mx-auto h-12 w-12 text-ink-faint" />
                    <h3 className="mt-4 text-lg font-bold text-ink">{t('noCheatSheetGenerated')}</h3>
                    <p className="mt-2 text-ink-soft">
                      {t('generateCheatSheetDescription')}
                    </p>
                    <button
                      onClick={generateCheatSheet}
                      disabled={!hasSummaries || generating.cheatSheet}
                      className={`mt-4 px-4 py-2 rounded-lg font-medium flex items-center gap-2 mx-auto ${
                        !hasSummaries || generating.cheatSheet
                          ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                          : 'bg-green-600 hover:bg-green-700 text-white shadow-md'
                      }`}
                    >
                      {generating.cheatSheet ? (
                        <>
                          <Loader  className="h-5 w-5 animate-spin" />
                          {t('generating')}
                        </>
                      ) : (
                        <>
                          <File className="h-5 w-5" />
                          {t('generateCheatSheet')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Quiz Tab */}
            {activeMaterialTab === 'quiz' && (
              <div>
                {quizzes.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex flex-wrap gap-2 mb-4">
                      {quizzes.map((quiz) => (
                      <div
                        key={quiz.id}
                        className={`px-3 py-1 text-sm rounded-lg flex items-center justify-between ${
                          activeQuiz === quiz.id
                            ? 'bg-purple-600 text-white'
                            : 'bg-gray-200 hover:bg-gray-300'
                        }`}
                      >
                        <button
                          onClick={() => {
                            setActiveQuiz(quiz.id);
                            setQuizResults(null);
                          }}
                          className="flex-1 text-left"
                        >
                          {new Date(quiz.createdAt).toLocaleDateString(locale)}
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteQuiz(quiz.id);
                          }}
                          className="ml-2 text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      ))}
                    </div>

                    <div className="flex justify-end">
                        <button
                          onClick={generateQuiz}
                          disabled={generating.quiz}
                          className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 ${
                            generating.quiz
                              ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                              : 'bg-purple-600 hover:bg-purple-700 text-white shadow-md'
                          }`}
                        >
                          {generating.quiz ? (
                            <>
                              <Loader className="h-4 w-4 animate-spin" />
                              {t('generating')}
                            </>
                          ) : (
                            <>
                              <RefreshCw className="h-4 w-4" />
                              {t('generateOtherTest')}
                            </>
                          )}
                        </button>
                      </div>
                    
                    {activeQuiz && (
                      <div>
                        {quizResults ? (
                          <div className="bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 rounded-xl p-6">
                            <h3 className="text-2xl font-bold text-center mb-6">{t('testResults')}</h3>
                            
                            <div className="text-center mb-8">
                              <div className="text-5xl font-bold text-purple-600 mb-2">
                                {quizResults.summary.correctAnswers}/{quizResults.summary.totalQuestions}
                              </div>
                              <div className="text-xl mb-1">{quizResults.summary.percentage}%</div>
                              <div className="text-lg font-medium mb-4">{t('grade')}: {quizResults.summary.grade}</div>
                              <p className="text-ink-soft">{quizResults.summary.feedback}</p>
                            </div>

                            <div className="space-y-6">
                              {quizResults.results.map((result, index: number) => (
                                <div 
                                  key={index} 
                                  className={`p-4 rounded-lg ${
                                    result.isCorrect ? 'bg-green-50' : 'bg-red-50'
                                  }`}
                                >
                                  <h4 className="font-bold flex items-center gap-2">
                                    {result.isCorrect ? (
                                      <CheckCircle className="h-5 w-5 text-green-500" />
                                    ) : (
                                      <XCircle className="h-5 w-5 text-red-500" />
                                    )}
                                    {result.question}
                                  </h4>
                                  
                                  <div className="mt-3">
                                    <p className="text-sm">
                                      <span className="font-medium">{t('yourAnswer')}:</span> 
                                      <span className={result.isCorrect ? "text-green-600" : "text-red-600"}>
                                        {" "}{result.options[result.userAnswer]}
                                      </span>
                                    </p>
                                    
                                    {!result.isCorrect && (
                                      <p className="text-sm mt-1">
                                        <span className="font-medium">{t('correctAnswer')}:</span> 
                                        <span className="text-green-600">{" "}{result.options[result.correctAnswer]}</span>
                                      </p>
                                    )}
                                    
                                    {result.explanation && (
                                      <div className="mt-3 p-3 bg-white rounded-md text-sm">
                                        <span className="font-medium">{t('explanation')}:</span> {result.explanation}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="mt-8 flex justify-center">
                              <button
                                onClick={restartQuiz}
                                className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                              >
                                {t('retakeTest')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-3 mb-5">
                              <CheckSquare className="h-6 w-6 text-purple-600" />
                              <h3 className="text-lg font-bold text-ink">{t('testEvaluation')}</h3>
                              <span className="text-sm text-black-500">
                                {new Date(
                                  quizzes.find(q => q.id === activeQuiz)?.createdAt || ''
                                ).toLocaleDateString(locale)}
                              </span>
                            </div>
                            <div className="bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 rounded-xl p-6">
                              {quizzes.find(q => q.id === activeQuiz)?.content.map((q, index: number) => (
                                <div key={index} className="mb-8 last:mb-0">
                                  <h3 className="font-semibold text-lg mb-4 flex text-black">
                                    <span className="bg-purple-600 text-white rounded-full h-8 w-8 flex items-center justify-center mr-3">
                                      {index + 1}
                                    </span>
                                    {q.question}
                                  </h3>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 ml-4">
                                    {q.options.map((option: string, optIndex: number) => {
                                      const isSelected = selectedAnswers[activeQuiz]?.[index] === optIndex;
                                      return (
                                        <div 
                                          key={optIndex} 
                                          onClick={() => handleAnswerSelect(activeQuiz, index, optIndex)}
                                          className={`p-3 rounded-lg border cursor-pointer transition-all ${
                                            isSelected
                                              ? 'bg-purple-100 border-purple-500 ring-2 ring-purple-200'
                                              : 'bg-white border-black hover:bg-sunken'
                                          }`}
                                        >
                                          <div className="flex items-start">
                                            <div className={`flex-shrink-0 mt-1 h-4 w-4 rounded-full border mr-3 ${
                                              isSelected ? 'bg-purple-600 border-purple-600' : 'border-line-strong'
                                            }`} />
                                            <span className="text-ink-soft">{option}</span>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                              <button
                                onClick={submitQuiz}
                                disabled={isSubmittingQuiz}
                                className="mt-6 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-medium shadow-md disabled:bg-purple-400"
                              >
                                {isSubmittingQuiz ? (
                                  <>
                                    <Loader className="mr-2 h-4 w-4 animate-spin inline" />
                                    {t('submitting')}
                                  </>
                                ) : (
                                  t('submitAnswers')
                                )}
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <CheckSquare className="mx-auto h-12 w-12 text-ink-faint" />
                    <h3 className="mt-4 text-lg font-bold text-ink">{t('noQuizGenerated')}</h3>
                    <p className="mt-2 text-ink-soft">
                      {t('generateQuizDescription')}
                    </p>
                    <button
                      onClick={generateQuiz}
                      disabled={!hasSummaries || generating.quiz}
                      className={`mt-4 px-4 py-2 rounded-lg font-medium flex items-center gap-2 mx-auto ${
                        !hasSummaries || generating.quiz
                          ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-700 text-white shadow-md'
                      }`}
                    >
                      {generating.quiz ? (
                        <>
                          <Loader  className="h-5 w-5 animate-spin" />
                          {t('generating')}
                        </>
                      ) : (
                        <>
                          <CheckSquare className="h-5 w-5" />
                          {t('generateQuiz')}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Course Files */}
        {course.files?.length > 0 && (
          <div className="mb-8 bg-white rounded-2xl shadow-lg p-6">
            <div className="flex items-center gap-3 mb-5">
              <FileText className="h-6 w-6 text-indigo-600" />
              <h2 className="text-xl font-bold text-ink">{t('coursesFiles')}</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {course.files.map((file) => (
                <div key={file.id} className="border border-line rounded-xl p-4 hover:shadow-md transition-shadow bg-sunken">
                  <div className="flex items-center">
                    <FileText className="h-5 w-5 text-blue-500 mr-2 flex-shrink-0" />
                    <h3 className="font-medium truncate">{file.name}</h3>
                  </div>
                  <p className="text-xs text-ink-faint mt-2">
                    {t('addedOn')} {new Date(file.createdAt).toLocaleDateString(locale)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {!hasContent && (
          <div className="text-center py-12 bg-white rounded-2xl shadow-lg">
            <div className="max-w-md mx-auto">
              <Folder className="mx-auto h-16 w-16 text-ink-faint" />
              <h3 className="mt-4 text-xl font-bold text-ink">{t('emptyCourse')}</h3>
              <p className="mt-2 text-ink-soft">
                {t('startByAddingSummaries')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Add Summaries Modal */}
      {showAddSummaries && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl text-black font-bold">{t('addSummariesToCourse')}</h3>
                <button 
                  onClick={() => setShowAddSummaries(false)}
                  className="text-ink-faint hover:text-ink-soft"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              
              {isLoadingSummaries ? (
                <div className="text-center py-8">
                  <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
                  <p className="mt-4 text-ink-soft">{t('loadingSummaries')}</p>
                </div>
              ) : availableSummaries.length === 0 ? (
                <div className="text-center py-8 text-ink-faint">
                  {t('noAvailableSummaries')}
                </div>
              ) : (
                <>
                  <div className="mb-4 max-h-[50vh] overflow-y-auto">
                    {availableSummaries.map((summary) => (
                      <div 
                        key={summary.id}
                        className={`p-3 border-b border-line flex items-center justify-between ${
                          selectedSummaryIds.includes(summary.id) 
                            ? 'bg-indigo-50' 
                            : 'hover:bg-sunken'
                        }`}
                      >
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={selectedSummaryIds.includes(summary.id)}
                            onChange={() => {
                              if (selectedSummaryIds.includes(summary.id)) {
                                setSelectedSummaryIds(prev => prev.filter(id => id !== summary.id));
                              } else {
                                setSelectedSummaryIds(prev => [...prev, summary.id]);
                              }
                            }}
                            className="mr-3 h-4 w-4 text-indigo-600 rounded"
                          />
                          <div>
                            <p className="text-ink font-medium">
                              {getSummaryName(summary)}
                            </p>
                            <p className="text-xs text-ink-faint mt-1">
                              {t('createdAt')}: {new Date(summary.createdAt).toLocaleDateString(locale)}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs text-ink-faint">
                          {summary.courses?.length || 0} {tCommon('courses')}
                        </span>
                      </div>
                    ))}
                  </div>
                  
                  <div className="flex justify-end gap-3 pt-4 border-t border-line">
                    <button
                      onClick={() => {
                        setShowAddSummaries(false);
                        setSelectedSummaryIds([]);
                      }}
                      className="px-5 py-2.5 rounded-xl font-medium border border-line-strong text-ink-soft hover:bg-sunken"
                    >
                      {tCommon('cancel')}
                    </button>
                    <button
                      onClick={addSelectedSummaryIds}
                      disabled={selectedSummaryIds.length === 0}
                      className={`px-5 py-2.5 rounded-xl font-medium flex items-center gap-2 ${
                        selectedSummaryIds.length === 0
                          ? 'bg-gray-200 text-ink-faint cursor-not-allowed'
                          : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-md'
                      }`}
                    >
                      <Plus className="h-5 w-5" />
                      {t('addSummariesCount', { count: selectedSummaryIds.length })}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Course Modal */}
      {showEditCourse && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md">
            <div className="p-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xl text-black font-bold">{t('editCourse')}</h3>
                <button 
                  onClick={() => setShowEditCourse(false)}
                  className="text-ink-faint hover:text-ink-soft"
                >
                  ✕
                </button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-black font-medium mb-2">{t('courseTitle')}</label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full p-3 border text-black border-line-strong rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    placeholder={t('courseTitlePlaceholder')}
                  />
                </div>
                
                <div>
                  <label className="block text-sm text-black font-medium mb-2">{t('courseDescription')}</label>
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="w-full p-3 border text-black border-line-strong rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    rows={3}
                    placeholder={t('courseDescriptionPlaceholder')}
                  />
                </div>
              </div>
              
              <div className="flex justify-end gap-3 pt-6 border-t border-line mt-6">
                <button
                  onClick={() => setShowEditCourse(false)}
                  className="px-5 py-2.5 rounded-xl font-medium border border-line-strong text-ink-soft hover:bg-sunken"
                >
                  {tCommon('cancel')}
                </button>
                <button
                  onClick={updateCourse}
                  className="px-5 py-2.5 rounded-xl font-medium bg-indigo-600 hover:bg-indigo-700 text-white shadow-md"
                >
                  {t('saveChanges')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Print Styles */}
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-container, .print-container * {
            visibility: visible;
          }
          .print-container {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 15px;
            box-shadow: none;
            border: none;
          }
          .no-print {
            display: none !important;
          }
        }
        
        /* Izolare completă pentru cheat sheet cu iframe */
        .cheat-sheet-isolated-container {
          width: 100% !important;
          max-width: 100% !important;
          height: 600px !important;
          max-height: 600px !important;
          overflow: hidden !important;
          border: 1px solid #e5e7eb;
          border-radius: 0.75rem;
          background: white;
          position: relative;
        }
        
        .cheat-sheet-iframe {
          width: 100% !important;
          height: 600px !important;
          max-height: 600px !important;
          min-height: 400px !important;
          border: none !important;
          display: block !important;
          background: white !important;
          overflow: hidden !important;
        }
        
        /* Forțează menținerea layout-ului original */
        .cheat-sheet-isolated-container * {
          box-sizing: border-box !important;
        }
        
        /* Previne orice schimbare de layout */
        @media (max-width: 768px) {
          .cheat-sheet-isolated-container {
            width: 100% !important;
            max-width: 100% !important;
          }
          .cheat-sheet-iframe {
            width: 100% !important;
          }
        }
      `}</style>
    </div>
  );
}