'use client';

import { useSession } from 'next-auth/react';
import { useState, useEffect, useCallback, use } from 'react';
import { FileText, ArrowLeft, CheckCircle, XCircle, RefreshCw, Shuffle } from 'react-feather';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
}

// Define the expected response type
interface QuizResponse {
  quiz: QuizQuestion[];
  fileName: string;
}

// Shuffle function using Fisher-Yates algorithm
const shuffleArray = <T,>(array: T[]): T[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

export default function QuizPage({ params }: { params: Promise<{ id: string }> }) {
  const t = useTranslations('quizDetail');
  const tCommon = useTranslations('common');
  const { data: session } = useSession();
  const router = useRouter();
  const resolvedParams = use(params);
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [fileName, setFileName] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [selectedOptions, setSelectedOptions] = useState<number[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(0);

  useEffect(() => {
    if (session) {
      fetchQuiz();
    }
  }, [session, resolvedParams.id]);

  const fetchQuiz = async () => {
    try {
      const response = await fetch(`/api/quizzes/${resolvedParams.id}`);
      const data: QuizResponse = await response.json();
      
      if (response.ok) {
        // Automatically shuffle the quiz when loading
        const shuffledQuiz = shuffleArray<QuizQuestion>(data.quiz);
        setQuiz(shuffledQuiz);
        setFileName(data.fileName);
      } else {
        console.error('Error fetching quiz:', data);
      }
    } catch (error) {
      console.error('Error fetching quiz:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Improved readability: Larger text sizes and better contrast
  const handleOptionSelect = (questionIndex: number, optionIndex: number) => {
    if (!submitted) {
      const newSelectedOptions = [...selectedOptions];
      newSelectedOptions[questionIndex] = optionIndex;
      setSelectedOptions(newSelectedOptions);
    }
  };

  // Updated shuffle function using functional update
  const shuffleQuestions = useCallback(() => {
    setQuiz(prevQuiz => shuffleArray<QuizQuestion>(prevQuiz));
    setSelectedOptions([]);
    setSubmitted(false);
    setScore(0);
  }, []);

  // New function to regenerate quiz
  const regenerateQuiz = async () => {
    setIsLoading(true);
    setSelectedOptions([]);
    setSubmitted(false);
    setScore(0);
    await fetchQuiz();
  };

  const calculateScore = () => {
    let correct = 0;
    quiz.forEach((question, index) => {
      if (selectedOptions[index] === question.correctAnswer) {
        correct++;
      }
    });
    setScore(correct);
    setSubmitted(true);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="mt-4 text-ink-soft">{t('loadingQuiz')}</p>
        </div>
      </div>
    );
  }

  if (quiz.length === 0) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-center max-w-md p-6 bg-surface border border-line rounded-card shadow-card">
          <div className="text-red-500 font-medium mb-4">{t('quizNotFound')}</div>
          <button
            onClick={() => router.push('/quizzes')}
            className="mt-4 inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('backToQuizzes')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <Link 
            href="/quizzes" 
            className="inline-flex items-center text-blue-600 hover:text-blue-800 mb-4"
          >
            <ArrowLeft className="mr-2 h-5 w-5" />
            {t('backToQuizzes')}
          </Link>
          
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-ink">{t('quiz')} {fileName}</h1>
              <p className="mt-1 text-ink-soft">
                {quiz.length} {t('questionsCount')} • {t('completeQuizToVerify')}
              </p>
            </div>
            
            {submitted && (
              <div className="bg-blue-50 px-4 py-2 rounded-lg">
                <span className="font-semibold text-blue-800">
                  {t('score')} {score}/{quiz.length} ({Math.round((score / quiz.length) * 100)}%)
                </span>
              </div>
            )}
          </div>

          {/* New buttons container */}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={shuffleQuestions}
              disabled={submitted}
              className={`flex items-center px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium ${
                submitted ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-700'
              }`}
            >
              <Shuffle className="mr-2 h-4 w-4" />
              {t('shuffleQuestionsButton')}
            </button>
            
            <button
              onClick={regenerateQuiz}
              className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('generateAnotherQuiz')}
            </button>
          </div>
        </div>

        <div className="space-y-8">
          {quiz.map((question, qIndex) => (
            <div 
              key={qIndex} 
              className="bg-surface border border-line rounded-card shadow-card-md overflow-hidden"
            >
              <div className="p-6">
                {/* Improved readability: Larger text and better spacing */}
                <h2 className="text-xl font-semibold text-ink mb-4 flex items-start">
                  <span className="bg-gray-200 rounded-full w-8 h-8 flex items-center justify-center mr-3 flex-shrink-0">
                    {qIndex + 1}
                  </span>
                  <span className="leading-relaxed">{question.question}</span>
                </h2>
                
                <div className="space-y-4 ml-11">
                  {question.options.map((option, oIndex) => {
                    const isSelected = selectedOptions[qIndex] === oIndex;
                    const isCorrect = oIndex === question.correctAnswer;
                    const showFeedback = submitted && (isSelected || isCorrect);
                    
                    return (
                      <div
                        key={oIndex}
                        className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                          !submitted && isSelected 
                            ? 'border-blue-600 bg-blue-50' 
                            : 'border-line hover:border-blue-300'
                        } ${
                          showFeedback 
                            ? isCorrect 
                              ? 'border-green-500 bg-green-50' 
                              : (isSelected ? 'border-red-500 bg-red-50' : '') 
                            : ''
                        }`}
                        onClick={() => handleOptionSelect(qIndex, oIndex)}
                      >
                        <div className="flex items-center">
                          <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center mr-3 ${
                            isSelected 
                              ? (submitted && !isCorrect ? 'border-red-500' : 'border-blue-500') 
                              : 'border-line-strong'
                          }`}>
                            {isSelected && (
                              <div className={`w-3 h-3 rounded-full ${
                                submitted && !isCorrect ? 'bg-red-500' : 'bg-blue-500'
                              }`}></div>
                            )}
                          </div>
                          {/* Improved readability: Larger text size */}
                          <span className="text-ink text-base">{option}</span>
                          
                          {showFeedback && (
                            <span className="ml-auto">
                              {isCorrect ? (
                                <CheckCircle className="h-5 w-5 text-green-500" />
                              ) : isSelected ? (
                                <XCircle className="h-5 w-5 text-red-500" />
                              ) : null}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>

        {!submitted ? (
          <div className="mt-8 text-center">
            <button
              onClick={calculateScore}
              disabled={selectedOptions.length !== quiz.length}
              className={`px-8 py-4 bg-blue-600 text-white rounded-full font-bold text-lg shadow-lg hover:bg-blue-700 transition ${
                selectedOptions.length !== quiz.length ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {t('checkAnswersButton')}
            </button>
            <p className="mt-3 text-ink-faint">
              {selectedOptions.length} {t('outOf')} {quiz.length} {t('questionsCompleted')}
            </p>
          </div>
        ) : (
          <div className="mt-8 bg-surface border border-line rounded-card shadow-card-md p-6 text-center">
            <h2 className="text-2xl font-bold text-ink mb-2">
              {t('yourResult')} {score}/{quiz.length}
            </h2>
            <p className="text-lg text-ink-soft mb-6">
              {t('answeredCorrectlyPercent', { percent: Math.round((score / quiz.length) * 100) })}
            </p>
            <div className="flex justify-center gap-4">
              <button
                onClick={() => window.location.reload()}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
              >
                {t('retakeQuiz')}
              </button>
              <Link
                href="/quizzes"
                className="px-6 py-3 bg-gray-200 text-ink rounded-lg font-medium hover:bg-gray-300"
              >
                {t('otherQuizzes')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}