import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/authOptions';
import prisma from '@/lib/prisma';
import { createChatCompletion } from '@/lib/ai-client';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type QuizQuestion = {
  question: string;
  options: string[];
  correct: number;
  explanation?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  topic: string;
};

// POST - Generează quiz pentru curs
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  // Token-bucket limit on LLM usage, per user
  const rateLimit = await checkRateLimit('ai', session.user.id);
  if (!rateLimit.success) {
    return rateLimitResponse(rateLimit) as NextResponse;
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // Obține datele utilizatorului pentru a verifica abonamentul
    const userData = await prisma.user.findUnique({
      where: { id: userId },
      select: { subscription: true }
    });

    if (!userData) {
      return NextResponse.json({ error: 'Utilizatorul nu a fost găsit' }, { status: 404 });
    }

    const isPremium = userData.subscription === 'premium';

    // Obține cursul cu toate rezumatele
    const course = await prisma.course.findUnique({
      where: { 
        id: courseId,
        userId: userId 
      },
      include: { 
        summaries: {
          include: {
            summary: {
              select: {
                id: true,
                title: true,
                content: true,
                language: true
              }
            }
          },
          orderBy: {
            addedAt: 'asc'
          }
        } 
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Cursul nu a fost găsit' }, { status: 404 });
    }

    if (course.summaries.length === 0) {
      return NextResponse.json({ error: 'Cursul nu conține rezumate' }, { status: 400 });
    }

    // Detectează limba predominantă din rezumate
    const languages = course.summaries.map(cs => cs.summary.language || 'en');
    const languageCount: Record<string, number> = {};
    languages.forEach(lang => languageCount[lang] = (languageCount[lang] || 0) + 1);
    const predominantLanguage = Object.keys(languageCount).reduce((a, b) => languageCount[a] > languageCount[b] ? a : b);

    // Combină toate rezumatele
    const combinedContent = course.summaries
      .map(cs => `## ${cs.summary.title}\n\n${cs.summary.content}`)
      .join('\n\n---\n\n');

    // Generează quiz-ul cu statusul premium și limba
    const quizData = await generateQuiz(course.title, combinedContent, isPremium, predominantLanguage);

    // Verifică dacă există deja un quiz pentru acest curs
    const existingQuiz = await prisma.quiz.findFirst({
      where: { courseId: courseId }
    });

    let savedQuiz;
    if (existingQuiz) {
      // Actualizează quiz-ul existent
      savedQuiz = await prisma.quiz.update({
        where: { id: existingQuiz.id },
        data: { questions: quizData }
      });
    } else {
      // Creează un quiz nou
      savedQuiz = await prisma.quiz.create({
        data: {
          questions: quizData,
          course: {
            connect: { id: courseId }
          },
          user: {
            connect: { id: userId }
          }
        }
      });
    }

    return NextResponse.json({ 
      success: true,
      quiz: {
        id: savedQuiz.id,
        content: savedQuiz.questions,
        createdAt: savedQuiz.createdAt
      },
      questionCount: Array.isArray(savedQuiz.questions) ? (savedQuiz.questions as QuizQuestion[]).length : 0,
      isPremium: isPremium
    });

  } catch (error) {
    console.error('Error generating quiz:', error);
    return NextResponse.json({ 
      error: 'Eroare la generarea testului' 
    }, { status: 500 });
  }
}

// GET - Obține quiz-ul existent
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    // Verifică dacă cursul aparține utilizatorului
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Cursul nu a fost găsit' }, { status: 404 });
    }

    // Găsește toate quiz-urile pentru acest curs
    const quizzes = await prisma.quiz.findMany({
      where: { courseId: courseId },
      orderBy: { createdAt: 'desc' }
    });

    if (!quizzes || quizzes.length === 0) {
      return NextResponse.json({ 
        quizzes: [],
        courseTitle: course.title
      });
    }

    // Formatează quiz-urile pentru afișare
    const formattedQuizzes = quizzes.map(quiz => ({
      id: quiz.id,
      content: quiz.questions,
      createdAt: quiz.createdAt
    }));

    return NextResponse.json({
      quizzes: formattedQuizzes,
      courseTitle: course.title
    });

  } catch (error) {
    console.error('Error fetching quizzes:', error);
    return NextResponse.json({ error: 'Eroare server' }, { status: 500 });
  }
}

// DELETE - Șterge un quiz
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    const body = await req.json();
    const { quizId } = body;

    if (!quizId) {
      return NextResponse.json({ error: 'Quiz ID este necesar' }, { status: 400 });
    }

    // Verifică dacă cursul aparține utilizatorului
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Cursul nu a fost găsit' }, { status: 404 });
    }

    // Verifică dacă quiz-ul aparține cursului
    const quiz = await prisma.quiz.findFirst({
      where: {
        id: quizId,
        courseId: courseId
      }
    });

    if (!quiz) {
      return NextResponse.json({ error: 'Quiz-ul nu a fost găsit' }, { status: 404 });
    }

    // Șterge quiz-ul
    await prisma.quiz.delete({
      where: { id: quizId }
    });

    return NextResponse.json({ 
      success: true,
      message: 'Quiz șters cu succes'
    });

  } catch (error) {
    console.error('Error deleting quiz:', error);
    return NextResponse.json({ error: 'Eroare la ștergerea quiz-ului' }, { status: 500 });
  }
}

// PUT - Evaluează răspunsurile utilizatorului
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  
  if (!session?.user) {
    return NextResponse.json({ error: 'Neautorizat' }, { status: 401 });
  }

  const { id: courseId } = await params;
  const userId = session.user.id;

  try {
    const body = await req.json();
    const { answers, quizId } = body;

    if (!quizId) {
      return NextResponse.json({ error: 'Quiz ID este necesar' }, { status: 400 });
    }

    // Verifică cursul și obține quiz-ul cu limba
    const course = await prisma.course.findUnique({
      where: {
        id: courseId,
        userId: userId
      },
      include: {
        summaries: {
          include: {
            summary: {
              select: {
                language: true
              }
            }
          }
        }
      }
    });

    if (!course) {
      return NextResponse.json({ error: 'Cursul nu a fost găsit' }, { status: 404 });
    }

    const quiz = await prisma.quiz.findFirst({
      where: { 
        id: quizId,
        courseId: courseId 
      }
    });

    if (!quiz || !quiz.questions) {
      return NextResponse.json({ error: 'Quiz-ul nu a fost găsit' }, { status: 404 });
    }

    // Detectează limba predominantă din rezumate
    const languages = course.summaries.map(cs => cs.summary.language || 'en');
    const languageCount: Record<string, number> = {};
    languages.forEach(lang => languageCount[lang] = (languageCount[lang] || 0) + 1);
    const predominantLanguage = Object.keys(languageCount).reduce((a, b) => languageCount[a] > languageCount[b] ? a : b);

    const questions = quiz.questions as QuizQuestion[];
    
    // Evaluează răspunsurile
    const results = questions.map((question, index) => {
      const userAnswer = answers[index];
      const isCorrect = userAnswer === question.correct;
      
      return {
        questionIndex: index,
        question: question.question,
        userAnswer: userAnswer,
        correctAnswer: question.correct,
        isCorrect: isCorrect,
        explanation: question.explanation || '',
        difficulty: question.difficulty
      };
    });

    const correctAnswers = results.filter(r => r.isCorrect).length;
    const totalQuestions = questions.length;
    const percentage = Math.round((correctAnswers / totalQuestions) * 100);

    // Determină nota și feedback-ul
    const grade = calculateGrade(percentage);
    const feedback = generateFeedback(percentage, correctAnswers, totalQuestions, predominantLanguage);

    return NextResponse.json({
      results: results,
      summary: {
        correctAnswers: correctAnswers,
        totalQuestions: totalQuestions,
        percentage: percentage,
        grade: grade,
        feedback: feedback
      }
    });

  } catch (error) {
    console.error('Error evaluating quiz:', error);
    return NextResponse.json({ error: 'Eroare la evaluarea testului' }, { status: 500 });
  }
}

// Funcție principală pentru generarea quiz-ului
async function generateQuiz(
  courseTitle: string, 
  combinedContent: string,
  isPremium: boolean,
  language: string = 'ro'
): Promise<QuizQuestion[]> {
  // Folosește AI pentru a genera întrebări mai inteligente
  return await generateAIQuizQuestions(courseTitle, combinedContent, isPremium, language);
}

// Generează întrebări cu AI pentru a fi mai relevante și focalizate pe conținut
async function generateAIQuizQuestions(
  courseTitle: string,
  content: string,
  isPremium: boolean,
  language: string = 'ro'
): Promise<QuizQuestion[]> {
  const totalQuestions = isPremium ? 15 : 10;
  
  // Curăță conținutul de termeni structurali
  const cleanedContent = cleanContentForQuiz(content);
  
  try {
    // Shared AI client: retries + OpenAI secondary + Claude fallback
    const result = await createChatCompletion({
      model: 'gpt-4o-mini',
      system: 'You are an expert professor who creates high-quality multiple-choice quizzes.',
      prompt: getQuizGenerationPrompt(courseTitle, cleanedContent, totalQuestions, language),
      maxTokens: 3000,
      temperature: 0.3,
    });

    // Parse răspunsul AI și transformă în QuizQuestion[]
    return parseAIQuizResponse(result.content, language);

  } catch (error) {
    console.error('Error generating AI quiz:', error);
    // Fallback la generarea manuală dacă AI-ul nu merge
    return generateFallbackQuestions(cleanedContent, totalQuestions, language);
  }
}

// Curăță conținutul de termeni structurali și păstrează doar conținutul relevant
function cleanContentForQuiz(content: string): string {
  const lines = content.split('\n');
  const cleanedLines: string[] = [];
  
  const structuralPatterns = [
    /^##?\s*(subiecte principale|puncte cheie|aspecte importante|idei principale)/i,
    /^##?\s*(descriere|rezumat|introducere|concluzii|capitol|secțiune)/i,
    /primul\s+punct|al\s+doilea\s+punct|punctul\s+următor|următoarele\s+aspecte/i,
    /^##?\s*glossary\s+of\s+terms?/i,
    /^##?\s*glosar\s+(de\s+)?termeni/i,
    /^##?\s*overview|^##?\s*summary|^##?\s*conclusion/i,
    /^-\s*(primul|al doilea|ultimul)\s+punct/i,
    /^[0-9]+\.\s*(primul|al doilea|ultimul)/i
  ];
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Exclude liniile care conțin doar termeni structurali
    if (trimmedLine.length < 10) continue;
    
    const isStructural = structuralPatterns.some(pattern => pattern.test(trimmedLine));
    
    if (!isStructural && trimmedLine.length > 20 && 
        !trimmedLine.includes('primul punct') && 
        !trimmedLine.includes('al doilea punct') &&
        !trimmedLine.toLowerCase().includes('glossary of terms') &&
        !trimmedLine.toLowerCase().includes('glosar de termeni')) {
      cleanedLines.push(trimmedLine);
    }
  }
  
  return cleanedLines.join('\n').substring(0, 8000); // Limitează la 8000 caractere
}

// Generează prompt-ul pentru AI
function getQuizGenerationPrompt(courseTitle: string, content: string, questionCount: number, language: string): string {
  const prompts = {
    'ro': `Analizează următorul conținut de curs despre "${courseTitle}" și generează ${questionCount} întrebări de quiz inteligente și relevante.

CONȚINUT:
${content}

INSTRUCȚIUNI IMPORTANTE:
1. Creează întrebări despre conceptele REALE și SPECIFICE din conținut, NU despre structura rezumatului
2. Evită întrebări despre "glossary of terms", "primul punct", "al doilea punct" sau alte elemente structurale
3. Focalizează-te pe conceptele substantive, definițiile importante, formulele și aplicațiile practice
4. Fiecare întrebare trebuie să aibă 4 răspunsuri posibile (A, B, C, D) cu unul corect
5. Oferă o explicație scurtă pentru răspunsul corect
6. Creează întrebări de dificultate variată (ușoare, medii, grele)

FORMAT JSON pentru fiecare întrebare:
{
  "question": "Textul întrebării",
  "options": ["A) Opțiunea 1", "B) Opțiunea 2", "C) Opțiunea 3", "D) Opțiunea 4"],
  "correct": 0,
  "explanation": "Explicația răspunsului corect",
  "difficulty": "easy/medium/hard",
  "topic": "subiectul întrebării"
}

Returnează un array JSON cu toate întrebările.`,

    'en': `Analyze the following course content about "${courseTitle}" and generate ${questionCount} intelligent and relevant quiz questions.

CONTENT:
${content}

IMPORTANT INSTRUCTIONS:
1. Create questions about REAL and SPECIFIC concepts from content, NOT about summary structure
2. Avoid questions about "glossary of terms", "first point", "second point" or other structural elements
3. Focus on substantive concepts, important definitions, formulas and practical applications
4. Each question must have 4 possible answers (A, B, C, D) with one correct
5. Provide a short explanation for the correct answer
6. Create questions of varying difficulty (easy, medium, hard)

JSON FORMAT for each question:
{
  "question": "Question text",
  "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
  "correct": 0,
  "explanation": "Explanation of correct answer",
  "difficulty": "easy/medium/hard",
  "topic": "question subject"
}

Return a JSON array with all questions.`
  };
  
  return prompts[language as keyof typeof prompts] || prompts['en'];
}

// Parse răspunsul AI și convertește în QuizQuestion[]
function parseAIQuizResponse(response: string, language: string): QuizQuestion[] {
  try {
    // Încearcă să găsească și să parse JSON-ul din răspuns
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in AI response');
    }
    
    const questionsData = JSON.parse(jsonMatch[0]);
    const questions: QuizQuestion[] = [];
    
    for (const q of questionsData) {
      if (q.question && q.options && Array.isArray(q.options) && 
          q.options.length === 4 && typeof q.correct === 'number') {
        
        // Curăță opțiunile de prefixe A), B), etc.
        const cleanOptions = q.options.map((opt: string) => 
          opt.replace(/^[A-D]\)\s*/, '').trim()
        );
        
        questions.push({
          question: q.question,
          options: cleanOptions,
          correct: q.correct,
          explanation: q.explanation || 'Nu este disponibilă o explicație.',
          difficulty: q.difficulty || 'medium',
          topic: q.topic || 'general'
        });
      }
    }
    
    return questions;
  } catch (error) {
    console.error('Error parsing AI quiz response:', error);
    return [];
  }
}

// Funcție de fallback pentru generarea întrebărilor dacă AI-ul nu funcționează
function generateFallbackQuestions(content: string, totalQuestions: number, language: string): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  // Extrage concepte și informații pentru întrebări (versiune îmbunătățită)
  const concepts = extractImprovedConcepts(content);
  const definitions = extractImprovedDefinitions(content);
  const formulas = extractFormulasForQuiz(content);
  
  // Generează întrebări pe baza conceptelor extrase
  const conceptQuestions = generateImprovedConceptQuestions(concepts, language);
  const definitionQuestions = generateDefinitionQuestions(definitions, language);
  const formulaQuestions = generateFormulaQuestions(formulas, language);
  
  questions.push(...conceptQuestions.slice(0, Math.floor(totalQuestions * 0.5)));
  questions.push(...definitionQuestions.slice(0, Math.floor(totalQuestions * 0.3)));
  questions.push(...formulaQuestions.slice(0, Math.floor(totalQuestions * 0.2)));
  
  return shuffleArray(questions).slice(0, totalQuestions);
}

// Extrage concepte îmbunătățite, evitând termenii structurali
function extractImprovedConcepts(text: string): string[] {
  const concepts = new Set<string>();
  
  // Termeni structurali de evitat complet
  const excludePatterns = [
    /subiecte?\s+principale?/i,
    /puncte?\s+cheie/i,
    /aspecte?\s+importante?/i,
    /idei?\s+principale?/i,
    /primul?\s+punct/i,
    /al\s+doilea\s+punct/i,
    /punctul?\s+următor/i,
    /următoarele?\s+aspecte?/i,
    /descriere/i,
    /rezumat/i,
    /introducere/i,
    /concluzii?/i,
    /capitol/i,
    /secțiune/i,
    /glossary\s+of\s+terms?/i,
    /glosar\s+(de\s+)?termeni/i
  ];
  
  const sentences = text.split(/[.!?]+/);
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    
    // Skip scurte și cele cu pattern-uri excluse
    if (trimmed.length < 30) continue;
    
    const shouldExclude = excludePatterns.some(pattern => pattern.test(trimmed));
    if (shouldExclude) continue;
    
    // Caută concepte specifice cu pattern-uri îmbunătățite
    const conceptPatterns = [
      /([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})\s+(este|reprezintă|se\s+caracterizează|implică)/i,
      /principiul\s+([a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})/i,
      /conceptul\s+de\s+([a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})/i,
      /teoria\s+([a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})/i,
      /metoda\s+([a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})/i,
      /procesul\s+de\s+([a-zA-ZăâîșțĂÂÎȘȚ\s]{8,40})/i
    ];
    
    for (const pattern of conceptPatterns) {
      const match = pattern.exec(trimmed);
      if (match) {
        const concept = match[1].trim();
        
        // Validări suplimentare
        if (concept.length > 8 && concept.length < 50 && 
            !excludePatterns.some(p => p.test(concept)) &&
            /[a-zA-ZăâîșțĂÂÎȘȚ]{5,}/.test(concept)) {
          concepts.add(concept);
        }
      }
    }
  }
  
  return Array.from(concepts).slice(0, 6);
}

// Extrage definiții îmbunătățite
function extractImprovedDefinitions(text: string): Array<{term: string, definition: string}> {
  const definitions: Array<{term: string, definition: string}> = [];
  const sentences = text.split(/[.!?]+/);
  
  const excludePatterns = [
    /glossary\s+of\s+terms?/i,
    /glosar\s+(de\s+)?termeni/i,
    /subiecte?\s+principale?/i,
    /puncte?\s+cheie/i,
    /primul?\s+punct/i,
    /al\s+doilea\s+punct/i,
    /următoare/i,
    /anterior/i
  ];
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    
    if (trimmed.length < 25) continue;
    
    const shouldExclude = excludePatterns.some(pattern => pattern.test(trimmed));
    if (shouldExclude) continue;
    
    const definitionPatterns = [
      /([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s]{4,35})\s+(este|reprezintă|se\s+definește\s+ca|înseamnă|constituie)\s+(.{20,120})/i,
      /([A-ZĂÂÎȘȚ][a-zA-ZăâîșțĂÂÎȘȚ\s]{4,35})\s*[-:]\s*(.{20,120})/i
    ];
    
    for (const pattern of definitionPatterns) {
      const match = pattern.exec(trimmed);
      if (match) {
        const term = match[1].trim();
        const definition = (match[3] || match[2]).trim();
        
        if (term.length > 4 && term.length < 40 && 
            definition.length > 20 && definition.length < 150 &&
            !excludePatterns.some(p => p.test(term)) &&
            !excludePatterns.some(p => p.test(definition))) {
          definitions.push({ term, definition });
        }
      }
    }
  }
  
  return definitions.slice(0, 5);
}

// Generează întrebări îmbunătățite despre concepte
function generateImprovedConceptQuestions(concepts: string[], language: string = 'ro'): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  for (const concept of concepts) {
    const templates = getImprovedConceptTemplates(language);
    
    const wrongAnswers = [
      templates.wrongAnswers[0].replace('{concept}', concept),
      templates.wrongAnswers[1].replace('{concept}', concept),
      templates.wrongAnswers[2].replace('{concept}', concept)
    ];
    
    const correctAnswer = templates.correctAnswer.replace('{concept}', concept);
    const options = shuffleArray([correctAnswer, ...wrongAnswers]);
    const correctIndex = options.indexOf(correctAnswer);
    
    if (correctIndex !== -1) {
      questions.push({
        question: templates.question.replace('{concept}', concept),
        options: options,
        correct: correctIndex,
        explanation: templates.explanation.replace('{concept}', concept),
        difficulty: 'medium',
        topic: 'concepte'
      });
    }
  }
  
  return questions;
}

// Template-uri îmbunătățite pentru întrebări despre concepte
function getImprovedConceptTemplates(language: string) {
  const templates = {
    'ro': {
      question: 'Care dintre următoarele afirmații despre {concept} este corectă?',
      correctAnswer: '{concept} joacă un rol important în domeniul studiat',
      wrongAnswers: [
        '{concept} nu are aplicabilitate practică',
        '{concept} este relevant doar în teoria de bază',
        '{concept} nu este considerat relevant în context modern'
      ],
      explanation: '{concept} este un element esențial în înțelegerea domeniului studiat.',
      topic: 'concepte fundamentale'
    },
    'en': {
      question: 'Which of the following statements about {concept} is correct?',
      correctAnswer: '{concept} plays an important role in the studied field',
      wrongAnswers: [
        '{concept} has no practical applicability',
        '{concept} is relevant only in basic theory',
        '{concept} is not considered relevant in modern context'
      ],
      explanation: '{concept} is an essential element in understanding the studied field.',
      topic: 'fundamental concepts'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}

// Generează întrebări despre definiții
function generateDefinitionQuestions(definitions: Array<{term: string, definition: string}>, language: string = 'ro'): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  definitions.forEach(def => {
    if (def.term && def.definition && def.term.length > 2 && def.definition.length > 10) {
      // Language-specific templates
      const templates = getDefinitionQuestionTemplates(language);
      
      // Creează răspunsuri greșite plausibile
      const wrongAnswers = [
        templates.wrongAnswers[0].replace('{term}', def.term.toLowerCase()),
        templates.wrongAnswers[1].replace('{term}', def.term.toLowerCase()),
        templates.wrongAnswers[2].replace('{term}', def.term.toLowerCase())
      ];
      
      const options = shuffleArray([def.definition, ...wrongAnswers]).slice(0, 4);
      const correctIndex = options.indexOf(def.definition);
      
      if (correctIndex !== -1) {
        questions.push({
          question: templates.question.replace('{term}', def.term),
          options: options,
          correct: correctIndex,
          explanation: templates.explanation.replace('{term}', def.term).replace('{definition}', def.definition),
          difficulty: 'easy',
          topic: templates.topic
        });
      }
    }
  });
  
  return questions;
}

// Generează întrebări despre formule
function generateFormulaQuestions(formulas: string[], language: string = 'ro'): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  formulas.forEach(formula => {
    if (formula.includes('=') && formula.length > 5) {
      const [left, right] = formula.split('=').map(s => s.trim());
      
      if (left && right) {
        // Creează variante greșite
        const wrongOptions = [
          `${left} = ${modifyFormula(right, 'add')}`,
          `${left} = ${modifyFormula(right, 'change_sign')}`,
          `${modifyVariable(left)} = ${right}`
        ].filter(opt => opt !== formula);
        
        const options = shuffleArray([formula, ...wrongOptions]).slice(0, 4);
        const correctIndex = options.indexOf(formula);
        
        const templates = getFormulaQuestionTemplates(language);
        
        if (correctIndex !== -1) {
          questions.push({
            question: templates.question.replace('{variable}', left),
            options: options,
            correct: correctIndex,
            explanation: templates.explanation.replace('{formula}', formula),
            difficulty: 'medium',
            topic: templates.topic
          });
        }
      }
    }
  });
  
  return questions;
}

// Generează întrebări despre concepte
function generateConceptQuestions(concepts: string[], language: string = 'ro'): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  concepts.forEach(concept => {
    if (concept && concept.length > 3) {
      const cleanConcept = concept.trim();
      const templates = getConceptQuestionTemplates(language);
      
      const wrongAnswers = [
        templates.wrongAnswers[0].replace('{concept}', cleanConcept),
        templates.wrongAnswers[1].replace('{concept}', cleanConcept),
        templates.wrongAnswers[2].replace('{concept}', cleanConcept)
      ];
      
      const correctAnswer = templates.correctAnswer.replace('{concept}', cleanConcept);
      const options = shuffleArray([correctAnswer, ...wrongAnswers]).slice(0, 4);
      const correctIndex = options.indexOf(correctAnswer);
      
      if (correctIndex !== -1) {
        questions.push({
          question: templates.question.replace('{concept}', cleanConcept),
          options: options,
          correct: correctIndex,
          explanation: templates.explanation.replace('{concept}', cleanConcept),
          difficulty: 'medium',
          topic: templates.topic
        });
      }
    }
  });
  
  return questions;
}

// Generează întrebări despre aplicații
function generateApplicationQuestions(procedures: string[], concepts: string[], language: string = 'ro'): QuizQuestion[] {
  const questions: QuizQuestion[] = [];
  
  if (procedures.length > 0) {
    const templates = getApplicationQuestionTemplates(language);
    
    const options = shuffleArray([templates.correctAnswer, ...templates.wrongAnswers]);
    const correctIndex = options.indexOf(templates.correctAnswer);
    
    questions.push({
      question: templates.question,
      options: options,
      correct: correctIndex,
      explanation: templates.explanation,
      difficulty: 'hard',
      topic: templates.topic
    });
  }
  
  return questions;
}

// Funcții helper pentru extragerea informațiilor
function extractConcepts(text: string): string[] {
  const concepts = new Set<string>();
  
  // Lista de termeni structurali de evitat
  const structuralTerms = [
    'subiecte principale', 'puncte cheie', 'aspecte importante', 'idei principale',
    'primul punct', 'al doilea punct', 'punctul următor', 'următoarele aspecte',
    'descriere', 'rezumat', 'introducere', 'concluzii', 'capitol', 'secțiune'
  ];
  
  const conceptPatterns = [
    /conceptul\s+de\s+([^.,!?\n]{5,40})/gi,
    /principiul\s+([^.,!?\n]{5,40})/gi,
    /teoria\s+([^.,!?\n]{5,40})/gi,
    /legea\s+([^.,!?\n]{5,40})/gi,
    /metoda\s+([^.,!?\n]{5,40})/gi,
    /fenomenul\s+([^.,!?\n]{5,40})/gi,
    /procesul\s+de\s+([^.,!?\n]{5,40})/gi,
    /noțiunea\s+de\s+([^.,!?\n]{5,40})/gi
  ];
  
  conceptPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const concept = match[1].trim();
      
      // Filter out structural terms and ensure quality
      if (concept.length > 4 && concept.length < 45 && 
          !structuralTerms.some(term => concept.toLowerCase().includes(term.toLowerCase())) &&
          !/^\d+/.test(concept) && // No numbers at start
          /[a-zA-ZăâîșțĂÂÎȘȚ]{3,}/.test(concept) && // Contains meaningful letters
          !concept.toLowerCase().includes('următoare') &&
          !concept.toLowerCase().includes('primul') &&
          !concept.toLowerCase().includes('ultimul')) {
        concepts.add(concept);
      }
    }
  });
  
  return Array.from(concepts).slice(0, 8);
}

function extractFormulasForQuiz(text: string): string[] {
  const formulas = new Set<string>();
  const formulaPatterns = [
    /([A-Z][a-z]?\s*=\s*[^.\n]{3,50})/g,
    /([a-zA-Z]+\s*=\s*[0-9][^.\n]{2,40})/g
  ];
  
  formulaPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const formula = match[1].trim();
      if (formula.length > 5 && formula.length < 60 && !formula.includes('http')) {
        formulas.add(formula);
      }
    }
  });
  
  return Array.from(formulas).slice(0, 6);
}

function extractDefinitionsForQuiz(text: string): Array<{term: string, definition: string}> {
  const definitions: Array<{term: string, definition: string}> = [];
  const sentences = text.split(/[.!?]+/);
  
  // Lista de termeni de evitat (structura rezumatului)
  const excludedTerms = [
    'descriere de subiecte principale', 'subiecte principale', 'puncte cheie', 
    'concluzii', 'rezumat', 'introducere', 'capitol', 'secțiune', 'partea',
    'aspecte importante', 'idei principale', 'obiective', 'scop', 'finalitate',
    'prezentare generală', 'overview', 'summary', 'conclusion', 'introduction'
  ];
  
  sentences.forEach(sentence => {
    const trimmed = sentence.trim();
    
    // Skip sentences that are too short or contain structural references
    if (trimmed.length < 20 || 
        excludedTerms.some(excluded => trimmed.toLowerCase().includes(excluded.toLowerCase())) ||
        /^##?\s/.test(trimmed) || // Skip markdown headers
        /^\d+\./.test(trimmed) || // Skip numbered lists
        /^-\s/.test(trimmed) || // Skip bullet points
        /primul\s+punct|al\s+doilea\s+punct|punctul\s+\d+/i.test(trimmed)) { // Skip point references
      return;
    }
    
    const definitionPatterns = [
      /([A-Z][a-zA-Z\s]{3,30})\s+(este|reprezintă|se\s+definește\s+ca|înseamnă|constituie)\s+(.{15,100})/i,
      /([A-Z][a-zA-Z\s]{3,30})\s*[-:]\s*(.{15,100})/i,
      /Prin\s+([a-zA-Z\s]{3,30})\s+se\s+(înțelege|subînțelege)\s+(.{15,100})/i
    ];
    
    definitionPatterns.forEach(pattern => {
      const match = pattern.exec(trimmed);
      if (match) {
        const term = (match[1] || match[1]).trim();
        const definition = (match[3] || match[2]).trim();
        
        // Additional filtering for term quality
        if (term.length > 3 && term.length < 35 && 
            definition.length > 15 && definition.length < 120 &&
            !excludedTerms.some(excluded => term.toLowerCase().includes(excluded.toLowerCase())) &&
            /[a-zA-ZăâîșțĂÂÎȘȚ]/.test(term) && // Contains actual letters
            !/^\d+/.test(term) && // Doesn't start with numbers
            !term.toLowerCase().includes('punctul') &&
            !term.toLowerCase().includes('capitolul') &&
            !definition.toLowerCase().includes('primul punct') &&
            !definition.toLowerCase().includes('următorul')) {
          definitions.push({ term, definition });
        }
      }
    });
  });
  
  // Remove duplicates and return limited set
  const uniqueDefinitions = definitions.filter((def, index, self) => 
    index === self.findIndex(d => d.term.toLowerCase() === def.term.toLowerCase())
  );
  
  return uniqueDefinitions.slice(0, 5);
}

function extractProcedures(text: string): string[] {
  const procedures: string[] = [];
  const sentences = text.split(/[.!?]+/);
  
  // Termeni structurali de evitat
  const structuralPhrases = [
    'primul punct', 'al doilea punct', 'punctul următor', 'următorul pas',
    'descriere de', 'rezumatul conține', 'aspectele principale', 'ideile cheie',
    'capitolul prezintă', 'secțiunea include'
  ];
  
  sentences.forEach(sentence => {
    const trimmed = sentence.trim();
    const indicators = ['pas', 'etap', 'procedur', 'algoritm', 'metodă', 'proces', 'tehnică'];
    
    // Filter for quality procedural content
    if (indicators.some(indicator => trimmed.toLowerCase().includes(indicator)) && 
        trimmed.length > 30 && trimmed.length < 180 &&
        !structuralPhrases.some(phrase => trimmed.toLowerCase().includes(phrase.toLowerCase())) &&
        !/^##?\s/.test(trimmed) && // No markdown headers
        !/^\d+\./.test(trimmed) && // No numbered lists
        !/primul\s+punct|punctul\s+\d+/i.test(trimmed) && // No point references
        /[a-zA-ZăâîșțĂÂÎȘȚ]{10,}/.test(trimmed)) { // Contains substantial text
      procedures.push(trimmed);
    }
  });
  
  return procedures.slice(0, 4);
}

// Funcții utilitare
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function modifyFormula(formula: string, type: 'add' | 'change_sign'): string {
  if (type === 'add') {
    return formula.replace(/\d+/g, (match) => String(parseInt(match) + 1));
  } else if (type === 'change_sign') {
    return formula.replace(/[+\-]/g, (match) => match === '+' ? '-' : '+');
  }
  return formula;
}

function modifyVariable(variable: string): string {
  return variable.replace(/[a-zA-Z]/g, 'x');
}

function calculateGrade(percentage: number): string {
  if (percentage >= 90) return '10';
  if (percentage >= 80) return '9';
  if (percentage >= 70) return '8';
  if (percentage >= 60) return '7';
  if (percentage >= 50) return '6';
  return '5';
}

function generateFeedback(percentage: number, correct: number, total: number, language: string = 'ro'): string {
  const templates = getFeedbackTemplates(language);
  
  if (percentage >= 90) {
    return templates.excellent.replace('{correct}', correct.toString()).replace('{total}', total.toString());
  } else if (percentage >= 70) {
    return templates.good.replace('{correct}', correct.toString()).replace('{total}', total.toString());
  } else if (percentage >= 50) {
    return templates.satisfactory.replace('{correct}', correct.toString()).replace('{total}', total.toString());
  } else {
    return templates.poor.replace('{correct}', correct.toString()).replace('{total}', total.toString());
  }
}

// Language-specific question templates

function getDefinitionQuestionTemplates(language: string) {
  const templates = {
    'ro': {
      question: 'Care este definiția corectă pentru "{term}"?',
      wrongAnswers: [
        'Un tip de {term} folosit în alte domenii',
        'Procesul invers al {term}',
        'O metodă de calculare a {term}'
      ],
      explanation: '{term} se definește ca: {definition}',
      topic: 'definiții'
    },
    'en': {
      question: 'What is the correct definition for "{term}"?',
      wrongAnswers: [
        'A type of {term} used in other fields',
        'The inverse process of {term}',
        'A calculation method for {term}'
      ],
      explanation: '{term} is defined as: {definition}',
      topic: 'definitions'
    },
    'fr': {
      question: 'Quelle est la définition correcte de "{term}"?',
      wrongAnswers: [
        'Un type de {term} utilisé dans d\'autres domaines',
        'Le processus inverse de {term}',
        'Une méthode de calcul pour {term}'
      ],
      explanation: '{term} se définit comme : {definition}',
      topic: 'définitions'
    },
    'de': {
      question: 'Was ist die korrekte Definition für "{term}"?',
      wrongAnswers: [
        'Eine Art von {term}, die in anderen Bereichen verwendet wird',
        'Der umgekehrte Prozess von {term}',
        'Eine Berechnungsmethode für {term}'
      ],
      explanation: '{term} wird definiert als: {definition}',
      topic: 'Definitionen'
    },
    'es': {
      question: '¿Cuál es la definición correcta de "{term}"?',
      wrongAnswers: [
        'Un tipo de {term} usado en otros campos',
        'El proceso inverso de {term}',
        'Un método de cálculo para {term}'
      ],
      explanation: '{term} se define como: {definition}',
      topic: 'definiciones'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}

function getFormulaQuestionTemplates(language: string) {
  const templates = {
    'ro': {
      question: 'Care este formula corectă pentru calculul lui {variable}?',
      explanation: 'Formula corectă este: {formula}',
      topic: 'formule'
    },
    'en': {
      question: 'What is the correct formula for calculating {variable}?',
      explanation: 'The correct formula is: {formula}',
      topic: 'formulas'
    },
    'fr': {
      question: 'Quelle est la formule correcte pour calculer {variable}?',
      explanation: 'La formule correcte est : {formula}',
      topic: 'formules'
    },
    'de': {
      question: 'Was ist die korrekte Formel zur Berechnung von {variable}?',
      explanation: 'Die korrekte Formel ist: {formula}',
      topic: 'Formeln'
    },
    'es': {
      question: '¿Cuál es la fórmula correcta para calcular {variable}?',
      explanation: 'La fórmula correcta es: {formula}',
      topic: 'fórmulas'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}

function getConceptQuestionTemplates(language: string) {
  const templates = {
    'ro': {
      question: 'Ce se poate spune despre {concept}?',
      correctAnswer: '{concept} este un concept fundamental',
      wrongAnswers: [
        '{concept} nu este relevant în acest context',
        '{concept} se aplică doar în situații speciale',
        '{concept} este o metodă depășită'
      ],
      explanation: '{concept} reprezintă unul din conceptele de bază ale cursului.',
      topic: 'concepte'
    },
    'en': {
      question: 'What can be said about {concept}?',
      correctAnswer: '{concept} is a fundamental concept',
      wrongAnswers: [
        '{concept} is not relevant in this context',
        '{concept} only applies in special situations',
        '{concept} is an outdated method'
      ],
      explanation: '{concept} represents one of the basic concepts of the course.',
      topic: 'concepts'
    },
    'fr': {
      question: 'Que peut-on dire sur {concept}?',
      correctAnswer: '{concept} est un concept fondamental',
      wrongAnswers: [
        '{concept} n\'est pas pertinent dans ce contexte',
        '{concept} ne s\'applique que dans des situations spéciales',
        '{concept} est une méthode obsolète'
      ],
      explanation: '{concept} représente l\'un des concepts de base du cours.',
      topic: 'concepts'
    },
    'de': {
      question: 'Was kann über {concept} gesagt werden?',
      correctAnswer: '{concept} ist ein grundlegendes Konzept',
      wrongAnswers: [
        '{concept} ist in diesem Kontext nicht relevant',
        '{concept} gilt nur in besonderen Situationen',
        '{concept} ist eine veraltete Methode'
      ],
      explanation: '{concept} stellt eines der Grundkonzepte des Kurses dar.',
      topic: 'Konzepte'
    },
    'es': {
      question: '¿Qué se puede decir sobre {concept}?',
      correctAnswer: '{concept} es un concepto fundamental',
      wrongAnswers: [
        '{concept} no es relevante en este contexto',
        '{concept} solo se aplica en situaciones especiales',
        '{concept} es un método obsoleto'
      ],
      explanation: '{concept} representa uno de los conceptos básicos del curso.',
      topic: 'conceptos'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}

function getApplicationQuestionTemplates(language: string) {
  const templates = {
    'ro': {
      question: 'Când aplicăm procedurile menționate în curs, ce este important să facem?',
      correctAnswer: 'Se urmează pașii specificați în procedură',
      wrongAnswers: [
        'Se ignoră toți parametrii inițiali',
        'Se aplică formula în sens invers',
        'Se folosesc doar valorile aproximative'
      ],
      explanation: 'Este esențial să urmărim cu atenție toți pașii procedurii pentru a obține rezultate corecte.',
      topic: 'aplicații'
    },
    'en': {
      question: 'When applying the procedures mentioned in the course, what is important to do?',
      correctAnswer: 'Follow the steps specified in the procedure',
      wrongAnswers: [
        'Ignore all initial parameters',
        'Apply the formula in reverse',
        'Use only approximate values'
      ],
      explanation: 'It is essential to carefully follow all procedure steps to obtain correct results.',
      topic: 'applications'
    },
    'fr': {
      question: 'Lors de l\'application des procédures mentionnées dans le cours, qu\'est-il important de faire?',
      correctAnswer: 'Suivre les étapes spécifiées dans la procédure',
      wrongAnswers: [
        'Ignorer tous les paramètres initiaux',
        'Appliquer la formule en sens inverse',
        'Utiliser seulement des valeurs approximatives'
      ],
      explanation: 'Il est essentiel de suivre attentivement toutes les étapes de la procédure pour obtenir des résultats corrects.',
      topic: 'applications'
    },
    'de': {
      question: 'Was ist wichtig zu tun, wenn wir die im Kurs erwähnten Verfahren anwenden?',
      correctAnswer: 'Die im Verfahren angegebenen Schritte befolgen',
      wrongAnswers: [
        'Alle Anfangsparameter ignorieren',
        'Die Formel umgekehrt anwenden',
        'Nur Näherungswerte verwenden'
      ],
      explanation: 'Es ist wichtig, alle Verfahrensschritte sorgfältig zu befolgen, um korrekte Ergebnisse zu erhalten.',
      topic: 'Anwendungen'
    },
    'es': {
      question: 'Al aplicar los procedimientos mencionados en el curso, ¿qué es importante hacer?',
      correctAnswer: 'Seguir los pasos especificados en el procedimiento',
      wrongAnswers: [
        'Ignorar todos los parámetros iniciales',
        'Aplicar la fórmula en sentido inverso',
        'Usar solo valores aproximados'
      ],
      explanation: 'Es esencial seguir cuidadosamente todos los pasos del procedimiento para obtener resultados correctos.',
      topic: 'aplicaciones'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}

function getFeedbackTemplates(language: string) {
  const templates = {
    'ro': {
      excellent: 'Excelent! Ai răspuns corect la {correct} din {total} întrebări. Cunoștințele tale sunt foarte solide.',
      good: 'Bine! Ai răspuns corect la {correct} din {total} întrebări. Mai ai câteva aspecte de îmbunătățit.',
      satisfactory: 'Satisfăcător. Ai răspuns corect la {correct} din {total} întrebări. Recomand să mai studiezi materialele.',
      poor: 'Ai răspuns corect la doar {correct} din {total} întrebări. Este necesar să studiezi din nou cursul.'
    },
    'en': {
      excellent: 'Excellent! You answered {correct} out of {total} questions correctly. Your knowledge is very solid.',
      good: 'Good! You answered {correct} out of {total} questions correctly. You have a few areas to improve.',
      satisfactory: 'Satisfactory. You answered {correct} out of {total} questions correctly. I recommend studying the materials more.',
      poor: 'You answered only {correct} out of {total} questions correctly. You need to study the course again.'
    },
    'fr': {
      excellent: 'Excellent ! Vous avez répondu correctement à {correct} questions sur {total}. Vos connaissances sont très solides.',
      good: 'Bien ! Vous avez répondu correctement à {correct} questions sur {total}. Vous avez quelques aspects à améliorer.',
      satisfactory: 'Satisfaisant. Vous avez répondu correctement à {correct} questions sur {total}. Je recommande d\'étudier davantage les matériaux.',
      poor: 'Vous avez répondu correctement à seulement {correct} questions sur {total}. Vous devez étudier à nouveau le cours.'
    },
    'de': {
      excellent: 'Ausgezeichnet! Sie haben {correct} von {total} Fragen richtig beantwortet. Ihr Wissen ist sehr solide.',
      good: 'Gut! Sie haben {correct} von {total} Fragen richtig beantwortet. Sie haben einige Verbesserungsmöglichkeiten.',
      satisfactory: 'Befriedigend. Sie haben {correct} von {total} Fragen richtig beantwortet. Ich empfehle, die Materialien mehr zu studieren.',
      poor: 'Sie haben nur {correct} von {total} Fragen richtig beantwortet. Sie müssen den Kurs erneut studieren.'
    },
    'es': {
      excellent: '¡Excelente! Respondiste correctamente {correct} de {total} preguntas. Tu conocimiento es muy sólido.',
      good: '¡Bien! Respondiste correctamente {correct} de {total} preguntas. Tienes algunas áreas por mejorar.',
      satisfactory: 'Satisfactorio. Respondiste correctamente {correct} de {total} preguntas. Recomiendo estudiar más los materiales.',
      poor: 'Respondiste correctamente solo {correct} de {total} preguntas. Necesitas estudiar el curso nuevamente.'
    }
  };
  
  return templates[language as keyof typeof templates] || templates['en'];
}