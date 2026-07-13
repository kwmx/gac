import terminalKit from 'terminal-kit';

const { terminal: term } = terminalKit;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  dim: '\x1b[2m',
  underline: '\x1b[4m',
  cyan: '\x1b[36m',
  bgBlack: '\x1b[40m',
  brightWhite: '\x1b[97m'
};

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleWidth(text) {
  return String(text).replace(ANSI_PATTERN, '').length;
}

function parseHexColor(token) {
  if (!token) return null;
  const raw = token.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(raw)) return null;
  const hex = raw.length === 3 ? raw.split('').map((c) => `${c}${c}`).join('') : raw;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return { r, g, b };
}

function parseFgHex(token) {
  if (!token) return null;
  if (!token.startsWith('#')) return null;
  return parseHexColor(token);
}

function parseBgHex(token) {
  if (!token) return null;
  if (!token.startsWith('bg')) return null;
  const trimmed = token.replace(/^bg:/, 'bg').replace(/^bg#/, 'bg');
  const match = trimmed.match(/^bg(.+)$/);
  if (!match) return null;
  return parseHexColor(match[1]);
}

function isDefaultFg(token) {
  return token === 'default' || token === 'fg:default' || token === 'fg-default';
}

function isDefaultBg(token) {
  return token === 'bg:default' || token === 'bg-default';
}

function applyAnsi(styles, text) {
  let codes = '';
  for (const style of styles) {
    if (ANSI[style]) {
      codes += ANSI[style];
      continue;
    }
    if (isDefaultFg(style)) {
      codes += '\x1b[39m';
      continue;
    }
    if (isDefaultBg(style)) {
      codes += '\x1b[49m';
      continue;
    }
    const fgHex = parseFgHex(style);
    if (fgHex) {
      codes += `\x1b[38;2;${fgHex.r};${fgHex.g};${fgHex.b}m`;
      continue;
    }
    const bgHex = parseBgHex(style);
    if (bgHex) {
      codes += `\x1b[48;2;${bgHex.r};${bgHex.g};${bgHex.b}m`;
    }
  }

  if (!codes) return text;
  return `${codes}${text}${ANSI.reset}`;
}

function applyStyle(styles, text) {
  if (styles.some((style) => parseFgHex(style) || parseBgHex(style) || isDefaultFg(style) || isDefaultBg(style))) {
    return applyAnsi(styles, text);
  }

  let chain = term;
  for (const style of styles) {
    if (chain[style]) {
      chain = chain[style];
      continue;
    }
    return applyAnsi(styles, text);
  }

  if (chain && typeof chain.str === 'function') {
    return chain.str(text);
  }

  return applyAnsi(styles, text);
}

const DEFAULT_STYLES = {
  headerStyles: ['bold'],
  headerStylesByLevel: {
    1: ['bold', 'brightWhite'],
    2: ['bold'],
    3: ['bold'],
    4: ['dim'],
    5: ['dim'],
    6: ['dim']
  },
  headerUnderline: true,
  headerUnderlineLevels: [1],
  headerUnderlineStyle: ['dim'],
  headerUnderlineChar: '─',
  codeStyles: ['cyan'],
  codeBackground: ['bgBlack'],
  codeBorder: true,
  codeBorderStyle: ['dim'],
  codeGutter: '│ ',
  codeBorderChars: {
    topLeft: '┌',
    top: '─',
    topRight: '┐',
    bottomLeft: '└',
    bottom: '─',
    bottomRight: '┘'
  },
  syntaxHighlight: true,
  syntaxStyles: {
    keyword: ['brightWhite', 'bold'],
    string: ['brightGreen'],
    comment: ['dim'],
    number: ['brightYellow']
  },
  tableBorderStyle: ['dim'],
  tableHeaderStyles: ['bold']
};

function normalizeStyles(styles) {
  if (!styles) return [];
  return Array.isArray(styles) ? styles : [styles];
}

function mergeStyles(options) {
  return {
    ...DEFAULT_STYLES,
    ...options,
    codeBorderChars: {
      ...DEFAULT_STYLES.codeBorderChars,
      ...(options && options.codeBorderChars ? options.codeBorderChars : {})
    },
    headerStylesByLevel: {
      ...DEFAULT_STYLES.headerStylesByLevel,
      ...(options && options.headerStylesByLevel ? options.headerStylesByLevel : {})
    },
    syntaxStyles: {
      ...DEFAULT_STYLES.syntaxStyles,
      ...(options && options.syntaxStyles ? options.syntaxStyles : {})
    }
  };
}

function applyInlineMarkdown(text) {
  let output = text;

  output = output.replace(/`([^`]+)`/g, (match, code) => applyStyle(['dim'], code));
  output = output.replace(/\*\*([^*]+)\*\*/g, (match, bold) => applyStyle(['bold'], bold));
  output = output.replace(/_([^_]+)_/g, (match, italic) => applyStyle(['italic'], italic));
  output = output.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match, label, url) => `${applyStyle(['underline'], label)} (${url})`
  );

  return output;
}

// ─────────────────────────────────────────────────────────────────
// Syntax highlighting (line-based, best-effort)
// ─────────────────────────────────────────────────────────────────

const LANG_ALIASES = {
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  typescript: 'javascript', node: 'javascript',
  py: 'python', python: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash',
  go: 'go', golang: 'go',
  rs: 'rust', rust: 'rust',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', 'c++': 'c',
  java: 'java',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  rb: 'ruby', ruby: 'ruby',
  php: 'php'
};

// comment: 'hash' (# ...), 'slash' (// ...), 'dash' (-- ...), or null.
const LANG_DEFS = {
  javascript: {
    comment: 'slash',
    keywords:
      'const let var function return if else for while do class extends import export from new async await try catch finally throw switch case break continue default typeof instanceof of in yield static delete void null undefined true false this super'
  },
  python: {
    comment: 'hash',
    keywords:
      'def return if elif else for while class import from as with try except finally raise pass break continue lambda global nonlocal yield assert del not and or in is None True False async await'
  },
  bash: {
    comment: 'hash',
    keywords:
      'if then else elif fi for while until do done case esac function in select time echo exit return local export set unset readonly shift source alias cd sudo true false'
  },
  go: {
    comment: 'slash',
    keywords:
      'func return if else for range switch case break continue default fallthrough package import type struct interface map chan go defer select var const nil true false'
  },
  rust: {
    comment: 'slash',
    keywords:
      'fn return if else for while loop match impl trait struct enum use mod pub let mut const static ref crate self super move async await dyn where type unsafe true false'
  },
  c: {
    comment: 'slash',
    keywords:
      'int char long short float double void unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue default sizeof goto volatile inline include define ifdef ifndef endif NULL true false class public private protected new delete namespace using template virtual bool auto'
  },
  java: {
    comment: 'slash',
    keywords:
      'public private protected class interface extends implements return if else for while do switch case break continue default new static final void int long double float boolean char byte short import package try catch finally throw throws this super null true false var record enum'
  },
  sql: {
    comment: 'dash',
    caseInsensitive: true,
    keywords:
      'select from where insert into values update set delete create table drop alter add index view join inner left right outer on as and or not null primary key foreign references group by order having limit offset distinct union all exists between like in is count sum avg min max'
  },
  ruby: {
    comment: 'hash',
    keywords:
      'def end return if elsif else unless for while until do class module require include attr_accessor puts print lambda proc yield begin rescue ensure raise break next case when then nil true false self'
  },
  php: {
    comment: 'slash',
    keywords:
      'function return if else elseif for foreach while do switch case break continue default class extends implements new echo print public private protected static const var use namespace try catch finally throw null true false as require include'
  },
  json: { comment: null, keywords: 'true false null' },
  yaml: { comment: 'hash', keywords: 'true false null' }
};

const COMMENT_PATTERNS = {
  // Hash comments must not fire on things like ${#var} or $#.
  hash: '(?<=^|\\s)#.*$',
  // Slash comments must not fire inside URLs (http://...).
  slash: '(?<!:)\\/\\/.*$',
  dash: '--.*$'
};

const STRING_PATTERN = '"(?:[^"\\\\]|\\\\.)*"?|\'(?:[^\'\\\\]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?';
const NUMBER_PATTERN = '\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?\\b';

const matcherCache = new Map();

function getLangMatcher(lang) {
  const canonical = LANG_ALIASES[String(lang || '').toLowerCase()] || null;
  const cacheKey = canonical || '(generic)';
  if (matcherCache.has(cacheKey)) return matcherCache.get(cacheKey);

  const def = canonical ? LANG_DEFS[canonical] : { comment: null, keywords: '' };
  const parts = [];
  const types = [];
  if (def.comment && COMMENT_PATTERNS[def.comment]) {
    parts.push(COMMENT_PATTERNS[def.comment]);
    types.push('comment');
  }
  parts.push(STRING_PATTERN);
  types.push('string');
  parts.push(NUMBER_PATTERN);
  types.push('number');
  if (def.keywords) {
    const words = def.keywords.split(/\s+/).filter(Boolean).join('|');
    parts.push(`\\b(?:${words})\\b`);
    types.push('keyword');
  }
  const flags = def.caseInsensitive ? 'gim' : 'gm';
  const matcher = {
    regex: new RegExp(parts.map((part) => `(${part})`).join('|'), flags),
    types
  };
  matcherCache.set(cacheKey, matcher);
  return matcher;
}

// Split one line of code into typed fragments: 'code' (unstyled base),
// 'comment', 'string', 'number', or 'keyword'. Line-based by design, so
// multi-line strings and block comments are highlighted best-effort.
export function highlightCodeLine(line, lang) {
  const text = String(line ?? '');
  if (!text) return [];
  const { regex, types } = getLangMatcher(lang);
  regex.lastIndex = 0;
  const fragments = [];
  let cursor = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) {
      fragments.push({ text: text.slice(cursor, match.index), type: 'code' });
    }
    let type = 'code';
    for (let i = 0; i < types.length; i += 1) {
      if (match[i + 1] !== undefined) {
        type = types[i];
        break;
      }
    }
    fragments.push({ text: match[0], type });
    cursor = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (cursor < text.length) {
    fragments.push({ text: text.slice(cursor), type: 'code' });
  }
  return fragments;
}

// ─────────────────────────────────────────────────────────────────
// Tables
// ─────────────────────────────────────────────────────────────────

export function isTableRow(line) {
  const trimmed = String(line ?? '').trim();
  return trimmed.length > 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
}

export function isTableSeparator(line) {
  return /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/.test(String(line ?? ''));
}

function splitTableCells(line) {
  const trimmed = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseAlignment(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

function matchFence(line) {
  const match = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)?(```|~~~)\s*([A-Za-z0-9_+-]+)?\s*$/);
  if (!match) return null;
  return { fence: match[1], lang: (match[2] || '').toLowerCase() };
}

export function createMarkdownRenderer(options = {}) {
  const styles = mergeStyles(options);
  const state = {
    inCodeBlock: false,
    inIndentedCode: false,
    fenceType: null,
    codeLang: null,
    prevBlank: true,
    markdownWrapper: false,
    wrapperFenceType: null,
    tableBuffer: []
  };

  function headerStylesForLevel(level) {
    const levelStyles = styles.headerStylesByLevel && styles.headerStylesByLevel[level];
    return normalizeStyles(levelStyles || styles.headerStyles);
  }

  function renderHeader(level, text, prefix = '') {
    const styledHeader = applyStyle(headerStylesForLevel(level), text);
    const underlineAllowed =
      styles.headerUnderline &&
      (!Array.isArray(styles.headerUnderlineLevels) || styles.headerUnderlineLevels.includes(level));
    if (!underlineAllowed) {
      return `${state.prevBlank ? '' : '\n'}${prefix}${styledHeader}`;
    }
    const underline = (styles.headerUnderlineChar || '─').repeat(Math.max(text.length, 4));
    const separator = state.prevBlank ? '' : '\n';
    const pad = prefix ? ' '.repeat(prefix.replace(/\t/g, '    ').length) : '';
    return `${separator}${prefix}${styledHeader}\n${pad}${applyStyle(normalizeStyles(styles.headerUnderlineStyle), underline)}`;
  }

  function ruleLine(left, fill, right) {
    const width = Math.max(20, Math.min(term.width || 80, 100));
    const inner = Math.max(width - 2, 1);
    return applyStyle(normalizeStyles(styles.codeBorderStyle), `${left}${fill.repeat(inner)}${right}`);
  }

  function renderCodeLine(line) {
    const prefix = applyStyle(normalizeStyles(styles.codeBorderStyle), styles.codeGutter);
    const baseStyles = [...normalizeStyles(styles.codeBackground), ...normalizeStyles(styles.codeStyles)];
    if (styles.syntaxHighlight === false) {
      return `${prefix}${applyStyle(baseStyles, line)}`;
    }
    const background = normalizeStyles(styles.codeBackground);
    const body = highlightCodeLine(line, state.codeLang)
      .map((fragment) => {
        if (fragment.type === 'code') {
          return applyStyle(baseStyles, fragment.text);
        }
        const tokenStyles = normalizeStyles(
          (styles.syntaxStyles || {})[fragment.type] || styles.codeStyles
        );
        return applyStyle([...background, ...tokenStyles], fragment.text);
      })
      .join('');
    return `${prefix}${body}`;
  }

  function renderTable(rows) {
    const headerCells = splitTableCells(rows[0]);
    const alignments = splitTableCells(rows[1]).map(parseAlignment);
    const bodyRows = rows.slice(2).map(splitTableCells);
    const columnCount = Math.max(
      headerCells.length,
      alignments.length,
      ...bodyRows.map((cells) => cells.length),
      1
    );
    const normalize = (cells) =>
      Array.from({ length: columnCount }, (_, i) => cells[i] ?? '');

    const renderHeaderCell = (cell) => {
      // Cells with inline markup keep their own styling; plain cells get the
      // table header style (nesting both would break the ANSI resets).
      if (/[`*_[]/.test(cell)) return applyInlineMarkdown(cell);
      return applyStyle(normalizeStyles(styles.tableHeaderStyles), cell);
    };
    const renderedHeader = normalize(headerCells).map(renderHeaderCell);
    const renderedBody = bodyRows.map((cells) => normalize(cells).map(applyInlineMarkdown));

    const widths = Array.from({ length: columnCount }, (_, i) =>
      Math.max(
        visibleWidth(renderedHeader[i]),
        ...renderedBody.map((cells) => visibleWidth(cells[i])),
        3
      )
    );

    // If the table cannot fit the terminal, emit the raw rows instead of a
    // mangled grid.
    const totalWidth = widths.reduce((sum, w) => sum + w, 0) + (columnCount - 1) * 3;
    if (totalWidth > (term.width || 80)) {
      return rows.map((row) => applyInlineMarkdown(row)).join('\n');
    }

    const border = (text) => applyStyle(normalizeStyles(styles.tableBorderStyle), text);
    const columnSeparator = border(' │ ');
    const pad = (text, width, align) => {
      const slack = Math.max(0, width - visibleWidth(text));
      if (align === 'right') return ' '.repeat(slack) + text;
      if (align === 'center') {
        const leftPad = Math.floor(slack / 2);
        return ' '.repeat(leftPad) + text + ' '.repeat(slack - leftPad);
      }
      return text + ' '.repeat(slack);
    };
    const renderRow = (cells) =>
      cells.map((cell, i) => pad(cell, widths[i], alignments[i] || 'left')).join(columnSeparator);
    const separatorLine = border(widths.map((w) => '─'.repeat(w)).join('─┼─'));

    return [renderRow(renderedHeader), separatorLine, ...renderedBody.map(renderRow)].join('\n');
  }

  function flushTableBuffer() {
    const rows = state.tableBuffer;
    state.tableBuffer = [];
    if (rows.length >= 2 && isTableSeparator(rows[1])) {
      return renderTable(rows);
    }
    // Not actually a table; render the buffered lines as normal markdown.
    return rows.map((row) => renderMarkdownLine(row, row.trim())).join('\n');
  }

  function renderMarkdownLine(sanitized, trimmed) {
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*|#+\s*)?$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      return renderHeader(level, headerText);
    }

    const listHeaderMatch = sanitized.match(
      /^(\s*[-*+]+\s+|\s*\d+[.)]\s+)(#{1,6})\s+(.+?)(?:\s+#+\s*|#+\s*)?$/
    );
    if (listHeaderMatch) {
      const prefix = listHeaderMatch[1];
      const level = listHeaderMatch[2].length;
      const headerText = listHeaderMatch[3];
      return renderHeader(level, headerText, prefix);
    }

    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(trimmed)) {
      const underline = (styles.headerUnderlineChar || '─').repeat(24);
      return applyStyle(normalizeStyles(styles.headerUnderlineStyle), underline);
    }

    if (trimmed.startsWith('>')) {
      return applyStyle(['dim'], applyInlineMarkdown(sanitized));
    }

    return applyInlineMarkdown(sanitized);
  }

  // Returns the rendered line, or null when the line was buffered (table rows
  // are collected until the table ends so column widths can be computed).
  function renderLine(line) {
    const sanitized = line.replace(/\r/g, '');
    const trimmed = sanitized.trim();
    const canBufferTable = !state.inCodeBlock && !state.inIndentedCode;

    if (state.tableBuffer.length) {
      if (canBufferTable && isTableRow(sanitized)) {
        state.tableBuffer.push(sanitized);
        return null;
      }
      const flushed = flushTableBuffer();
      const rest = renderLine(line);
      return rest === null ? flushed : `${flushed}\n${rest}`;
    }

    if (canBufferTable && isTableRow(sanitized)) {
      state.tableBuffer.push(sanitized);
      state.prevBlank = false;
      return null;
    }

    const isBlank = trimmed.length === 0;
    const indentedMatch = sanitized.match(/^(?:\t| {4,})(.*)$/);
    const fenceMatch = matchFence(sanitized);
    if (fenceMatch) {
      const { fence, lang } = fenceMatch;
      if (state.inCodeBlock && fence === state.fenceType && !lang) {
        state.inCodeBlock = false;
        state.fenceType = null;
        state.codeLang = null;
        if (!styles.codeBorder) return '';
        const chars = styles.codeBorderChars;
        state.prevBlank = false;
        return ruleLine(chars.bottomLeft, chars.bottom, chars.bottomRight);
      }
      if (state.inCodeBlock) {
        state.prevBlank = false;
        return renderCodeLine(sanitized);
      }
      if (state.markdownWrapper && fence === state.wrapperFenceType && !lang) {
        state.markdownWrapper = false;
        state.wrapperFenceType = null;
        state.prevBlank = false;
        return '';
      }
      if (!state.markdownWrapper && (lang === 'markdown' || lang === 'md')) {
        state.markdownWrapper = true;
        state.wrapperFenceType = fence;
        state.prevBlank = false;
        return '';
      }
      state.inCodeBlock = true;
      state.fenceType = fence;
      state.codeLang = lang || null;
      if (!styles.codeBorder) return '';
      const chars = styles.codeBorderChars;
      state.prevBlank = false;
      return ruleLine(chars.topLeft, chars.top, chars.topRight);
    }

    if (state.inCodeBlock) {
      state.prevBlank = false;
      return renderCodeLine(sanitized);
    }

    if (state.inIndentedCode) {
      if (indentedMatch) {
        state.prevBlank = false;
        return renderCodeLine(indentedMatch[1]);
      }
      state.inIndentedCode = false;
      state.codeLang = null;
      if (styles.codeBorder) {
        const chars = styles.codeBorderChars;
        const closing = ruleLine(chars.bottomLeft, chars.bottom, chars.bottomRight);
        state.prevBlank = isBlank;
        return `${closing}\n${renderMarkdownLine(sanitized, trimmed)}`;
      }
      state.prevBlank = isBlank;
      return renderMarkdownLine(sanitized, trimmed);
    }

    if (indentedMatch && state.prevBlank) {
      state.inIndentedCode = true;
      state.codeLang = null;
      if (styles.codeBorder) {
        const chars = styles.codeBorderChars;
        const opening = ruleLine(chars.topLeft, chars.top, chars.topRight);
        state.prevBlank = false;
        return `${opening}\n${renderCodeLine(indentedMatch[1])}`;
      }
      state.prevBlank = false;
      return renderCodeLine(indentedMatch[1]);
    }

    state.prevBlank = isBlank;
    return renderMarkdownLine(sanitized, trimmed);
  }

  // Emit anything still buffered (a table not yet terminated by a non-table
  // line). Call at end of stream/document.
  function flush() {
    if (!state.tableBuffer.length) return '';
    return flushTableBuffer();
  }

  function resetState() {
    state.inCodeBlock = false;
    state.inIndentedCode = false;
    state.fenceType = null;
    state.codeLang = null;
    state.prevBlank = true;
    state.markdownWrapper = false;
    state.wrapperFenceType = null;
    state.tableBuffer = [];
  }

  function renderText(text) {
    // renderText renders a self-contained document, so start from a clean
    // state. Otherwise an unbalanced code fence in one message would leak
    // into every subsequent renderText call sharing this renderer.
    resetState();
    const lines = text.split('\n');
    const rendered = [];
    for (const line of lines) {
      const result = renderLine(line);
      if (result !== null) rendered.push(result);
    }
    const pending = flush();
    if (pending) rendered.push(pending);
    return rendered.join('\n');
  }

  return { renderLine, renderText, flush, state };
}
