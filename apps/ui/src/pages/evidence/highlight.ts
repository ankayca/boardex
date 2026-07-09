// Minimal per-line C tokenizer for the Code Diff tab's syntax highlighting
// (BIBLE §7.4). Deliberately restrained: it distinguishes exactly the token
// classes the §6.1 palette can express without touching the reserved colors
// (D14) — preprocessor directives, keywords (+ *_t typedef names), comments,
// and string/char literals. Per-line by construction: a diff interleaves
// added/removed/context lines, so cross-line lexer state (an open /* block)
// cannot be tracked honestly; an unterminated /* highlights to end of line.
export type TokenKind = 'plain' | 'keyword' | 'comment' | 'string' | 'preproc';

export interface Token {
  text: string;
  kind: TokenKind;
}

const C_KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline',
  'int', 'long', 'register', 'restrict', 'return', 'short', 'signed', 'sizeof',
  'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void',
  'volatile', 'while',
]);

const TOKEN_RE =
  /(?<comment>\/\/.*$|\/\*.*?(?:\*\/|$))|(?<string>"(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$))|(?<ident>[A-Za-z_][A-Za-z0-9_]*)/g;

function identKind(ident: string): TokenKind {
  if (C_KEYWORDS.has(ident) || /^[A-Za-z_][A-Za-z0-9_]*_t$/.test(ident)) return 'keyword';
  return 'plain';
}

// Tokenize one line of C. Adjacent plain stretches stay merged so the renderer
// emits as few spans as possible.
export function tokenizeC(line: string): Token[] {
  if (/^\s*#/.test(line)) return [{ text: line, kind: 'preproc' }];

  const tokens: Token[] = [];
  let last = 0;
  const pushPlain = (upTo: number) => {
    if (upTo > last) tokens.push({ text: line.slice(last, upTo), kind: 'plain' });
  };

  for (const match of line.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    const text = match[0];
    const groups = match.groups ?? {};
    const kind: TokenKind = groups['comment']
      ? 'comment'
      : groups['string']
        ? 'string'
        : identKind(text);
    if (kind === 'plain') continue; // fold into the surrounding plain stretch
    pushPlain(index);
    tokens.push({ text, kind });
    last = index + text.length;
  }
  pushPlain(line.length);
  return tokens.length > 0 ? tokens : [{ text: line, kind: 'plain' }];
}
