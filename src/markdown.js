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
  const match = trimmed.match(/^bg(#.+)$/);
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
  }
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

function matchFence(line) {
  const match = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)?(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
  if (!match) return null;
  return { fence: match[1], lang: (match[2] || '').toLowerCase() };
}

export function createMarkdownRenderer(options = {}) {
  const styles = mergeStyles(options);
  const state = {
    inCodeBlock: false,
    inIndentedCode: false,
    fenceType: null,
    prevBlank: true,
    markdownWrapper: false,
    wrapperFenceType: null
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
    const codeStyles = [...normalizeStyles(styles.codeBackground), ...normalizeStyles(styles.codeStyles)];
    return `${prefix}${applyStyle(codeStyles, line)}`;
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

  function renderLine(line) {
    const sanitized = line.replace(/\r/g, '');
    const trimmed = sanitized.trim();
    const isBlank = trimmed.length === 0;
    const indentedMatch = sanitized.match(/^(?:\t| {4,})(.*)$/);
    const fenceMatch = matchFence(sanitized);
    if (fenceMatch) {
      const { fence, lang } = fenceMatch;
      if (state.inCodeBlock && fence === state.fenceType && !lang) {
        state.inCodeBlock = false;
        state.fenceType = null;
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

  function renderText(text) {
    const lines = text.split('\n');
    const rendered = lines.map((line) => renderLine(line));
    return rendered.join('\n');
  }

  return { renderLine, renderText, state };
}
