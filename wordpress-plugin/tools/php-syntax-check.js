/**
 * A crude PHP sanity check for a machine with no PHP binary.
 *
 * Strips comments, strings and heredocs FIRST, then balances delimiters.
 * Counting braces over raw source (what we were doing before) reports
 * "balanced" for files that contain a brace inside a comment or a string,
 * which is most of them — so it could never have caught a real fault.
 */
const fs = require('fs');

const BACKSLASH = String.fromCharCode(92);

function scan(src, file) {
  let i = 0;
  let out = '';
  const n = src.length;
  const errs = [];

  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);

    if (c2 === '//') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c2 === '/*') {
      const e = src.indexOf('*/', i + 2);
      if (e < 0) { errs.push('unterminated block comment'); break; }
      i = e + 2; continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === BACKSLASH) { i += 2; continue; }
        if (src[i] === quote) { closed = true; i++; break; }
        i++;
      }
      if (!closed) errs.push('unterminated ' + quote + ' string');
      out += '""';
      continue;
    }

    if (c2 === '<<') {
      const m = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i));
      if (m) {
        const tag = m[2];
        const rest = src.slice(i + m[0].length);
        const mm = new RegExp('^[ \\t]*' + tag + '\\b', 'm').exec(rest);
        if (!mm) { errs.push('unterminated heredoc ' + tag); break; }
        i += m[0].length + mm.index + mm[0].length;
        out += '""';
        continue;
      }
    }

    out += c;
    i++;
  }

  const stack = [];
  const closes = { '}': '{', ')': '(', ']': '[' };
  let line = 1;
  for (const ch of out) {
    if (ch === '\n') { line++; continue; }
    if (ch === '{' || ch === '(' || ch === '[') stack.push({ ch, line });
    else if (ch === '}' || ch === ')' || ch === ']') {
      const top = stack.pop();
      if (!top) errs.push('line ' + line + ": stray '" + ch + "'");
      else if (top.ch !== closes[ch]) {
        errs.push('line ' + line + ": '" + ch + "' closes '" + top.ch + "' opened on line " + top.line);
      }
    }
  }
  for (const left of stack) errs.push('line ' + left.line + ": '" + left.ch + "' is never closed");

  if (errs.length) console.log('FAIL ' + file + '\n       ' + errs.join('\n       '));
  else console.log('ok   ' + file);
  return errs.length;
}

let bad = 0;
for (const f of process.argv.slice(2)) bad += scan(fs.readFileSync(f, 'utf8'), f);
console.log(bad ? '\n' + bad + ' problem(s)' : '\nAll files balanced.');
process.exit(bad ? 1 : 0);
