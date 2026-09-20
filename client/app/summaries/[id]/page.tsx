'use client';

import { useSession } from 'next-auth/react';
import { useState, useEffect, use } from 'react';
import { Download, ArrowLeft, Printer, Trash2, BookOpen } from 'react-feather';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
// Sanitizes the HTML that rehypeRaw parses out of AI-generated summary text,
// which is derived from user-uploaded PDFs (prompt-injection -> stored XSS).
import rehypeSanitize from 'rehype-sanitize';
import 'katex/dist/katex.min.css';
import { InlineMath, BlockMath } from 'react-katex';
import { useTranslations, useLocale } from 'next-intl';
import { analyticsEvents } from '@/lib/analytics';
import MarkdownContent, { formatMarkdownSpacing } from '@/components/MarkdownContent';

type Summary = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  userId: string;
  coursesCount: number;
  courses: Array<{
    id: string;
    title: string;
  }>;
  // Backward compatibility properties
  name?: string;
  summary?: string;
  size?: string;
  pages?: number;
  characters?: number;
  language?: string;
  isPremium?: boolean;
};

// Funcție optimizată pentru parsarea conținutului premium
const parsePremiumContent = (content: string, lang: string = 'ro') => {
  const sectionTitles = [
    "1. Introducere și context",
    "2. Concepte fundamentale", 
    "3. Dezvoltare pe capitole",
    "4. Glosar tehnic extins",
    "5. Relații și formule esențiale",
    "6. Comparații și clasificări",
    "7. Întrebări de autoevaluare avansate"
  ];

  const sections: Record<string, string> = {};
  const lines = content.split('\n');
  let currentSection = "";
  let currentContent = "";

  for (const line of lines) {
    // Verifică dacă linia conține un titlu de secțiune
    const titleMatch = sectionTitles.find(title => 
      line.includes(`## ${title}`) || 
      line.includes(title)
    );
    
    if (titleMatch) {
      if (currentSection) {
        sections[currentSection] = currentContent.trim();
      }
      currentSection = titleMatch;
      currentContent = "";
    } else if (currentSection) {
      currentContent += line + '\n';
    }
  }

  if (currentSection) {
    sections[currentSection] = currentContent.trim();
  }

  // Completează secțiunile lipsă
  sectionTitles.forEach(title => {
    if (!sections[title]) {
      sections[title] = 'Conținut indisponibil';
    }
  });

  return sections;
};

export default function SummaryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Unwrap params using React.use()
  const resolvedParams = use(params);
  const { id } = resolvedParams;

  const t = useTranslations('summaryDetail');
  const tCommon = useTranslations('common');
  const tWorkspace = useTranslations('workspace');
  const locale = useLocale(); // Get current UI language
  const { data: session, status } = useSession();
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [revealedAnswers, setRevealedAnswers] = useState<Record<number, boolean>>({});

  useEffect(() => {
    console.log('Session status:', status);
    console.log('Session data:', session);
    
    if (status === 'loading') {
      // Session is still loading
      console.log('Session is loading...');
      return;
    }
    
    if (status === 'authenticated' && session) {
      console.log('User authenticated, fetching summary...');
      fetchSummary();
    } else if (status === 'unauthenticated') {
      console.log('User not authenticated');
      setIsLoading(false);
      setError(t('authRequired'));
    }
  }, [session, status, id]);

  const fetchSummary = async () => {
    try {
      console.log('Making request to:', `/api/summaries/${id}`);
      const response = await fetch(`/api/summaries/${id}`);
      console.log('Response status:', response.status);
      console.log('Response ok:', response.ok);
      
      const data = await response.json();
      console.log('Response data:', data);
      
      if (response.ok) {
        // Apply formatting to content
        const content = data.content || data.summary || '';
        data.content = formatMarkdownSpacing(content);
        data.summary = data.content; // For backward compatibility
        setSummary(data);
        console.log('Summary set successfully');
      } else {
        console.log('Error from API:', data.error);
        setError(data.error || t('loadingSummary'));
      }
    } catch (error) {
      console.error('Fetch error:', error);
      setError(t('connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async () => {
    if (!summary) return;
    
    // Track download event
    analyticsEvents.summaryDownloaded();
    analyticsEvents.buttonClick('download_summary', 'summary_detail_page');
    
    try {
      const response = await fetch(`/api/summaries/${id}/download`);
      if (response.status === 403) {
        const errorData = await response.json();
        alert(errorData.error || t('downloadErrorFree'));
        return;
      }
      if (!response.ok) throw new Error(t('downloadError'));
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const filename = (summary.title || summary.name || 'rezumat').replace('.pdf', '');
      a.download = `${filename}_summary.txt`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Eroare descărcare:', error);
      alert(t('downloadError'));
    }
  };

  const handleDelete = async () => {
    if (!summary) return;
    
    if (!confirm(t('deleteConfirm'))) {
      return;
    }

    // Track delete event
    analyticsEvents.summaryDeleted();
    analyticsEvents.buttonClick('delete_summary', 'summary_detail_page');

    try {
      const response = await fetch(`/api/summaries/${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        alert(t('deleteSuccess'));
        router.push('/summaries');
      } else {
        const errorData = await response.json();
        alert(`${tCommon('error')}: ${errorData.error}`);
      }
    } catch (error) {
      console.error('Eroare ștergere:', error);
      alert(t('deleteError'));
    }
  };

  const toggleAnswer = (index: number) => {
    setRevealedAnswers(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  // Funcție pentru procesarea întrebărilor de autoevaluare
  const parseAssessmentQuestions = (content: string) => {
    const questions = [];
    const lines = content.split('\n');
    let currentQuestion = null;

    for (const line of lines) {
      const questionMatch = line.match(/^(\d+\.)\s*(.+)/);
      
      if (questionMatch) {
        // Salvează întrebarea anterioară dacă există
        if (currentQuestion) {
          questions.push(currentQuestion);
        }
        
        currentQuestion = {
          number: questionMatch[1],
          question: questionMatch[2].trim(),
          answer: ""
        };
      } else if (currentQuestion && line.trim().startsWith("- Răspuns:")) {
        // Extrage răspunsul
        currentQuestion.answer = line.replace("- Răspuns:", "").trim();
      } else if (currentQuestion && line.trim()) {
        // Adaugă la întrebarea curentă dacă nu e răspuns
        if (!line.trim().startsWith("- Răspuns:")) {
          currentQuestion.question += " " + line.trim();
        }
      }
    }

    // Adaugă ultima întrebare
    if (currentQuestion) {
      questions.push(currentQuestion);
    }

    return questions;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-gray-600">{t('loadingSummary')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md p-6 bg-white rounded-lg shadow">
          <div className="text-red-500 font-medium mb-4">{error}</div>
          <button
            onClick={() => router.push('/summaries')}
            className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToSummaries')}
          </button>
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center max-w-md p-6 bg-white rounded-lg shadow">
          <div className="text-gray-900 font-medium mb-4">{t('summaryNotFound')}</div>
          <button
            onClick={() => router.push('/summaries')}
            className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToSummaries')}
          </button>
        </div>
      </div>
    );
  }

  // Use summary language for content, but UI language (locale) for interface labels
  const summaryLang = summary.language || 'ro'; // Language of the summary content
  const uiLang = locale || 'ro'; // Language of the UI (from browser/settings)

  const displayName = summary.title || summary.name || t('untitled');
  const displayContent = summary.content || summary.summary || t('noContentAvailable');
  
  // Detectare îmbunătățită a conținutului premium
  const hasPremiumStructure = 
    /## 5\. Relații și formule esențiale/.test(displayContent) || 
    /5\. Relații și formule esențiale/.test(displayContent) ||
    /## 4\. Glosar tehnic extins/.test(displayContent) ||
    /4\. Glosar tehnic extins/.test(displayContent);

  const isPremium = summary.isPremium && hasPremiumStructure;

  const sections = isPremium ? parsePremiumContent(displayContent, summaryLang) : null;
  const assessmentQuestions = sections?.["7. Întrebări de autoevaluare avansate"] 
    ? parseAssessmentQuestions(sections["7. Întrebări de autoevaluare avansate"])
    : [];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <Link 
            href="/summaries" 
            className="inline-flex items-center text-blue-600 hover:text-blue-800 mb-4"
          >
            <ArrowLeft className="mr-2 h-5 w-5" />
            {t('backToSummaries')}
          </Link>
          
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">{displayName}</h1>
              <p className="mt-2 text-gray-600">
                {t('createdOn')} {new Date(summary.createdAt).toLocaleDateString(uiLang === 'ro' ? 'ro-RO' : uiLang === 'en' ? 'en-US' : `${uiLang}-${uiLang.toUpperCase()}`)}
                {summary.pages && (
                  <>
                    {' • '}{summary.pages} {t('pages')}
                  </>
                )}
                {summary.characters && (
                  <>
                    {' • '}{summary.characters.toLocaleString()} {t('characters')}
                  </>
                )}
                {summary.coursesCount > 0 && (
                  <>
                    {' • '}{summary.coursesCount} {t('courses')}
                  </>
                )}
                {isPremium && <span className="ml-2 bg-purple-100 text-purple-800 px-2 py-1 rounded-full text-xs">PREMIUM</span>}
              </p>
            </div>
            
            <div className="flex gap-2">
              <Link
                href={`/workspace/${id}`}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700 font-medium"
              >
                <BookOpen className="h-4 w-4" />
                {tWorkspace('openWorkspace')}
              </Link>

              <button
                onClick={() => window.print()}
                className="flex items-center px-3 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300"
                title={t('print')}
              >
                <Printer className="h-4 w-4" />
              </button>
              
              <button
                onClick={handleDelete}
                className="flex items-center px-3 py-2 rounded-md bg-red-600 text-white hover:bg-red-700"
                title={t('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              
              <button
                onClick={handleDownload}
                className="flex items-center px-4 py-2 rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                <Download className="mr-1 h-4 w-4" />
                {t('download')}
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="p-6">
            <div className="prose max-w-none">
              {isPremium && sections ? (
                <>
                  {/* Secțiuni standard */}
                  {Object.entries(sections).filter(([title]) => title !== "7. Întrebări de autoevaluare avansate").map(([title, content], index) => (
                    <div 
                      key={index} 
                      className={`mb-8 ${
                        title.includes("formule") ? "bg-blue-50 p-4 rounded-lg border border-blue-200" :
                        title.includes("Glosar") ? "bg-green-50 p-4 rounded-lg border border-green-200" :
                        title.includes("Comparații") ? "bg-yellow-50 p-4 rounded-lg border border-yellow-200" : ""
                      }`}
                    >
                      <h2 className="text-2xl font-bold mb-4 border-b pb-2">{title}</h2>
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]} 
                        rehypePlugins={title.includes("Dezvoltare") ? [rehypeRaw, rehypeSanitize] : undefined}
                        components={{
                          table({ node, children, ...props }) {
                            return (
                              <div className="overflow-x-auto my-4">
                                <table className="min-w-full border-collapse border border-gray-300" {...props}>
                                  {children}
                                </table>
                              </div>
                            );
                          },
                          thead({ node, children, ...props }) {
                            return <thead className="bg-gray-100" {...props}>{children}</thead>;
                          },
                          tbody({ node, children, ...props }) {
                            return <tbody {...props}>{children}</tbody>;
                          },
                          tr({ node, children, ...props }) {
                            return <tr {...props}>{children}</tr>;
                          },
                          th({ node, children, ...props }) {
                            return <th className="border border-gray-300 px-4 py-2 text-left font-semibold" {...props}>{children}</th>;
                          },
                          td({ node, children, ...props }) {
                            return <td className="border border-gray-300 px-4 py-2" {...props}>{children}</td>;
                          },
                          code({ node, className, children, ...props }) {
                            const isInline = !className;
                            const text = String(children);
                            
                            // Enhanced formula detection
                            const isLatexFormula = /\\[a-zA-Z]+\{|\\frac\{|\\sqrt\{|\\sum|\\int|\\cdot|\\[a-zA-Z_]+|\$.*\$/.test(text);
                            const isMathFormula = /[A-Za-z_]+\s*[=≈≤≥<>]\s*|[A-Za-z_]+\s*[=≈≤≥<>]\s*[A-Za-z_0-9\s\.\,\-\+\*\/\(\)\{\}\[\]\\]+|\([A-Za-z_]+\s*[=≈≤≥<>]/.test(text);
                            const hasSubscriptSuperscript = /[A-Za-z_]+[_{][A-Za-z0-9}]+|[A-Za-z_]+\^[A-Za-z0-9]+|[A-Z]+_[A-Z]+/.test(text);
                            const containsFormulaKeywords = /Formulă:|Formula:|Formule:|Formel:/i.test(text);

                            // Function to convert common notation to LaTeX
                            const convertToLatex = (text: string) => {
                              return text
                                // Convert subscripts: A_1 -> A_{1}
                                .replace(/([A-Za-z]+)_([A-Za-z0-9]+)/g, '$1_{$2}')
                                // Convert superscripts: A^2 -> A^{2}
                                .replace(/([A-Za-z]+)\^([A-Za-z0-9]+)/g, '$1^{$2}')
                                // Convert fractions: a/b -> \frac{a}{b}
                                .replace(/([A-Za-z0-9]+)\/([A-Za-z0-9]+)/g, '\\frac{$1}{$2}')
                                // Convert multiplication: * -> \cdot
                                .replace(/\*/g, '\\cdot')
                                // Convert square root: sqrt -> \sqrt
                                .replace(/sqrt\(([^)]+)\)/g, '\\sqrt{$1}')
                                // Convert infinity
                                .replace(/infinity|∞/g, '\\infty')
                                // Convert degrees
                                .replace(/(\d+)°/g, '$1^{\\circ}')
                                // Remove Formula: prefix for cleaner display
                                .replace(/^(Formulă|Formula|Formule|Formel):\s*/i, '');
                            };

                            // Enhanced text processing for fallback display
                            const processFormulaText = (text: string) => {
                              return text
                                // Replace multiplication symbols
                                .replace(/\*/g, '×')
                                .replace(/\bx\b/g, '×')
                                // Improve subscripts and superscripts display
                                .replace(/([A-Za-z]+)_([A-Za-z0-9]+)/g, '$1₍$2₎')
                                .replace(/([A-Za-z]+)\^([A-Za-z0-9]+)/g, '$1^($2)')
                                // Replace common math symbols
                                .replace(/<=?/g, '≤')
                                .replace(/>=?/g, '≥')
                                .replace(/!=/g, '≠')
                                .replace(/~=/g, '≈')
                                // Format fractions better
                                .replace(/(\d+)\/(\d+)/g, '$1/$2')
                                // Improve spacing around operators
                                .replace(/([A-Za-z0-9])([=≈≤≥<>≠])([A-Za-z0-9])/g, '$1 $2 $3')
                                .replace(/([A-Za-z0-9])([+\-×])([A-Za-z0-9])/g, '$1 $2 $3');
                            };

                            if ((isLatexFormula || isMathFormula || hasSubscriptSuperscript || containsFormulaKeywords)) {
                              const latexText = convertToLatex(text.replace(/^\$|\$$/g, '')); // Remove $ delimiters

                              try {
                                if (!isInline) {
                                  // Get formula label based on UI language (not summary language)
                                  const formulaLabels: Record<string, string> = {
                                    en: 'Mathematical Formula',
                                    ro: 'Formulă Matematică',
                                    fr: 'Formule Mathématique',
                                    es: 'Fórmula Matemática',
                                    de: 'Mathematische Formel',
                                    it: 'Formula Matematica'
                                  };
                                  const formulaLabel = formulaLabels[uiLang] || formulaLabels.en;

                                  return (
                                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-lg p-6 my-6 shadow-lg">
                                      <div className="flex items-center mb-4">
                                        <div className="w-3 h-3 bg-blue-500 rounded-full mr-2"></div>
                                        <span className="text-sm font-bold text-blue-700 uppercase tracking-wide">{formulaLabel}</span>
                                      </div>
                                      <div className="bg-white rounded-lg p-4 border border-blue-200 shadow-sm">
                                        <BlockMath math={latexText} />
                                      </div>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <span className="inline-flex items-center bg-blue-100 border border-blue-300 rounded-md px-2 py-1 mx-1">
                                      <InlineMath math={latexText} />
                                    </span>
                                  );
                                }
                              } catch (error) {
                                // Fallback to enhanced text display if KaTeX fails
                                const processedText = processFormulaText(text);

                                if (!isInline) {
                                  // Get formula label based on UI language (not summary language)
                                  const formulaLabels: Record<string, string> = {
                                    en: 'Mathematical Formula',
                                    ro: 'Formulă Matematică',
                                    fr: 'Formule Mathématique',
                                    es: 'Fórmula Matemática',
                                    de: 'Mathematische Formel',
                                    it: 'Formula Matematica'
                                  };
                                  const formulaLabel = formulaLabels[uiLang] || formulaLabels.en;

                                  return (
                                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-lg p-6 my-6 shadow-md">
                                      <div className="flex items-center mb-3">
                                        <div className="w-3 h-3 bg-blue-500 rounded-full mr-2"></div>
                                        <span className="text-sm font-bold text-blue-700 uppercase tracking-wide">{formulaLabel}</span>
                                      </div>
                                      <div className="bg-white rounded-md p-4 border border-blue-200">
                                        <code className="font-mono text-blue-900 text-xl font-bold whitespace-pre-wrap block leading-relaxed" {...props}>
                                          {processedText}
                                        </code>
                                      </div>
                                    </div>
                                  );
                                } else {
                                  return (
                                    <code className="font-mono text-blue-800 bg-blue-100 px-3 py-1 rounded-md text-lg font-bold shadow-sm border border-blue-200" {...props}>
                                      {processedText}
                                    </code>
                                  );
                                }
                              }
                            }
                            
                            return isInline ? (
                              <code 
                                className="bg-gray-100 px-1.5 py-0.5 rounded text-red-600 font-mono text-sm"
                                {...props}
                              >
                                {children}
                              </code>
                            ) : (
                              <code 
                                className={`${className} bg-gray-100 block p-4 rounded-md overflow-x-auto font-mono text-sm`}
                                {...props}
                              >
                                {children}
                              </code>
                            );
                          },
                          a({ node, href, children, ...props }) {
                            return (
                              <a 
                                href={href} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:text-blue-800 underline"
                                {...props}
                              >
                                {children}
                              </a>
                            );
                          }
                        }}
                      >
                        {content}
                      </ReactMarkdown>
                    </div>
                  ))}

                  {/* Secțiunea specială pentru întrebări */}
                  {assessmentQuestions.length > 0 && (
                    <div className="mt-10 pt-6 border-t border-gray-200">
                      <h2 className="text-2xl font-bold mb-4">{t('assessmentQuestions')}</h2>
                      <div className="space-y-6">
                        {assessmentQuestions.map((q, index) => (
                          <div key={index} className="p-4 bg-white rounded-lg border border-gray-200">
                            <div className="font-medium text-gray-800 cursor-pointer" 
                                 onClick={() => toggleAnswer(index)}>
                              <span className="text-blue-600">{q.number}</span> {q.question}
                              <span className="ml-2 text-blue-600 text-sm">
                                ({revealedAnswers[index] 
                                  ? t('hideAnswer')
                                  : t('showAnswer')})
                              </span>
                            </div>
                            
                            {revealedAnswers[index] && q.answer && (
                              <div className="mt-4 p-4 bg-blue-50 rounded-md border border-blue-200">
                                <strong className="text-blue-700 block mb-2">{t('answer')}</strong>
                                <div className="text-gray-700">{q.answer}</div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <MarkdownContent content={displayContent} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
