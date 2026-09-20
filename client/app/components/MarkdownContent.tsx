'use client';

// Shared markdown renderer for AI-generated study content (summaries, notes,
// chat answers). Extracted verbatim from app/summaries/[id]/page.tsx so the
// learning workspace and the print view render content identically.
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
// Sanitizes the HTML that rehypeRaw parses out of AI-generated summary text,
// which is derived from user-uploaded PDFs (prompt-injection -> stored XSS).
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
// Copying a KaTeX formula normally yields the stacked visual layer
// ("BW\nf\n0" for a fraction). copy-tex intercepts the copy event and puts
// the clean LaTeX source ($Q = \frac{f_0}{BW}$) on the clipboard instead.
import 'katex/dist/contrib/copy-tex';
import { InlineMath, BlockMath } from 'react-katex';
import { useLocale } from 'next-intl';

// Extends the GitHub sanitize schema so the class names remark-math attaches
// survive sanitization; rehype-katex (which runs after) needs them to find
// the formulas. KaTeX output itself is generated locally, so it is safe.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [...(defaultSchema.attributes?.div || []), ['className', 'math', 'math-display']],
    span: [...(defaultSchema.attributes?.span || []), ['className', 'math', 'math-inline']],
    code: [...(defaultSchema.attributes?.code || []), ['className', 'language-math', 'math-inline', 'math-display']],
  },
};

// Funcție îmbunătățită pentru formatarea Markdown
export const formatMarkdownSpacing = (text: string) => {
  // Improved section title preservation
  let formatted = text
    // Preserve section titles exactly as they are
    .replace(/(\n## \d+\.\s+[^\n]+)/g, '$1\n\n')
    // Add spacing before headers
    .replace(/(?<=\n)(#+\s?.*)/g, '\n\n$1')
    // Add spacing around code blocks
    .replace(/(```[\s\S]*?```)(?=\S)/g, '$1\n\n')
    // Add spacing between paragraphs
    .replace(/(?<=\S)\n(?=\S)/g, '\n\n');

  // Fix duplicate table separator rows and ensure proper table structure
  // Remove all separator rows first
  formatted = formatted.replace(/^\s*\|[\s\-:|]+\|\s*$/gm, '');

  // Clean up extra newlines in tables
  formatted = formatted.replace(/(\|[^\n]+\|)\n\n+(\|[^\n]+\|)/g, '$1\n$2');

  // Add back proper separators after header rows
  formatted = formatted.replace(/(\|[^\n]+\|)\n(\|(?!\s*-)[^\n]+\|)/g, (match, header, nextRow) => {
    const columnCount = (header.match(/\|/g) || []).length - 1;
    const separator = '|' + ' --- |'.repeat(columnCount);
    return `${header}\n${separator}\n${nextRow}`;
  });

  return formatted;
};

export default function MarkdownContent({ content }: { content: string }) {
  const locale = useLocale();
  const uiLang = locale || 'ro';

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
      components={{
        h1({ node, children, ...props }) {
          const text = String(children);
          const isMainSection = /^\d+\.\s/.test(text);
          return (
            <h1
              className={`text-3xl font-bold mt-8 mb-4 pb-2 ${
                isMainSection
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent border-b-2 border-blue-300'
                  : 'border-b'
              }`}
              {...props}
            >
              {children}
            </h1>
          );
        },
        h2({ node, children, ...props }) {
          const text = String(children);
          const isMainSection = /^\d+\.\s/.test(text);
          return (
            <h2
              className={`text-2xl font-bold mt-6 mb-3 pb-1 ${
                isMainSection
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent border-b-2 border-blue-200'
                  : 'border-b'
              }`}
              {...props}
            >
              {children}
            </h2>
          );
        },
        h3({ node, children, ...props }) {
          const text = String(children);
          const isTechnicalSection = text.includes('Glosar') || text.includes('Formule') || text.includes('Glossary') || text.includes('Formula') || text.includes('Formulas') || text.includes('Formules') || text.includes('Formeln') || text.includes('Formule');
          return (
            <h3
              className={`text-xl font-bold mt-4 mb-2 ${
                isTechnicalSection ? 'text-green-700 bg-green-50 p-2 rounded-md' : ''
              }`}
              {...props}
            >
              {children}
            </h3>
          );
        },
        h4({ node, children, ...props }) {
          return <h4 className="text-lg font-semibold mt-3 mb-1 text-indigo-700" {...props}>{children}</h4>;
        },
        p({ node, children, ...props }) {
          return <p className="mb-4 text-gray-700 leading-relaxed" {...props}>{children}</p>;
        },
        ul({ node, children, ...props }) {
          return <ul className="list-disc pl-6 mb-4 space-y-1" {...props}>{children}</ul>;
        },
        ol({ node, children, ...props }) {
          return <ol className="list-decimal pl-6 mb-4 space-y-1" {...props}>{children}</ol>;
        },
        li({ node, children, ...props }) {
          return <li className="mb-1" {...props}>{children}</li>;
        },
        code({ node, className, children, ...props }) {
          const isInline = !className;
          const text = String(children);

          // Enhanced formula detection (same as premium)
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
        },
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
        th({ node, children, ...props }) {
          return <th className="border border-gray-300 px-4 py-2 text-left font-semibold" {...props}>{children}</th>;
        },
        td({ node, children, ...props }) {
          return <td className="border border-gray-300 px-4 py-2" {...props}>{children}</td>;
        },
        blockquote({ node, children, ...props }) {
          const text = String(children);
          const isTechnicalNote = text.includes('Important') || text.includes('Note') || text.includes('Notă') || text.includes('Importante');

          return (
            <blockquote
              className={`border-l-4 pl-4 py-3 my-4 rounded-r-md ${
                isTechnicalNote
                  ? 'border-orange-500 bg-orange-50 text-orange-800'
                  : 'border-blue-500 bg-blue-50 text-gray-700'
              } italic`}
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        strong({ node, children, ...props }) {
          const text = String(children);
          const isLatexFormula = /\\[a-zA-Z]+\{|\\frac\{|\\sqrt\{|\\cdot|Formulă:|Formula:|Formule:|Formel:/i.test(text);
          const isMathFormula = /[A-Za-z_]+\s*[=≈≤≥<>]\s*|[A-Za-z_]+\s*[=≈≤≥<>]\s*[A-Za-z_0-9\s\.\,\-\+\*\/\(\)\{\}\[\]\\]+/.test(text);
          const hasSubscriptSuperscript = /[A-Za-z_]+[_{][A-Za-z0-9}]+|[A-Za-z_]+\^[A-Za-z0-9]+|[A-Z]+_[A-Z]+/.test(text);

          // Process formula text for better display
          const processFormulaText = (text: string) => {
            return text
              .replace(/\*/g, '×')
              .replace(/\bx\b/g, '×')
              .replace(/([A-Za-z]+)_([A-Za-z0-9]+)/g, '$1₍$2₎')
              .replace(/([A-Za-z]+)\^([A-Za-z0-9]+)/g, '$1^($2)')
              .replace(/<=?/g, '≤')
              .replace(/>=?/g, '≥')
              .replace(/!=/g, '≠')
              .replace(/~=/g, '≈')
              .replace(/(\d+)\/(\d+)/g, '$1/$2')
              .replace(/([A-Za-z0-9])([=≈≤≥<>≠])([A-Za-z0-9])/g, '$1 $2 $3')
              .replace(/([A-Za-z0-9])([+\-×])([A-Za-z0-9])/g, '$1 $2 $3');
          };

          if (isLatexFormula || isMathFormula || hasSubscriptSuperscript) {
            const processedText = processFormulaText(text);
            return (
              <strong className="font-mono text-blue-800 font-bold bg-blue-100 px-3 py-1 rounded-md border border-blue-200 text-lg" {...props}>
                {processedText}
              </strong>
            );
          }

          return <strong {...props}>{children}</strong>;
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
