// Repairs LaTeX whose leading backslash was eaten somewhere between the model
// and the page (a JS string escape or a JSON round-trip turns "\text" into
// TAB + "ext", "\frac" into FORM FEED + "rac", "\beta" into BACKSPACE + "eta").
// KaTeX then renders "extInternalEnergy" instead of "Internal Energy".
//
// Only the inside of math spans is touched: those control characters never
// occur legitimately in a formula, so mapping them back is safe.

const CONTROL_ESCAPES: Record<string, string> = {
  '\t': '\\t', // \text \times \theta \tau \tan ...
  '\f': '\\f', // \frac \forall ...
  '\b': '\\b', // \beta \bar \binom ...
  '\r': '\\r', // \rho \rightarrow \right ...
  '\v': '\\v', // \vec \varepsilon ...
  '\x07': '\\a', // \alpha \approx ...
};

const MATH_SPAN = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$/g;

export function repairMathEscapes(content: string): string {
  return content.replace(MATH_SPAN, (span) =>
    span
      .replace(/[\t\f\b\r\v\x07]/g, (ch) => CONTROL_ESCAPES[ch])
      // The backslash vanished without leaving a control character behind.
      .replace(
        /(^|[^\\A-Za-z])(ext|rac)\{/g,
        (_match, before: string, word: string) => `${before}\\${word === 'ext' ? 'text' : 'frac'}{`
      )
  );
}
