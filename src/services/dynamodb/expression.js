// services/dynamodb/expression.js — shared DynamoDB expression engine.
//
// Implements the grammar used by ConditionExpression, FilterExpression, and
// KeyConditionExpression: comparators, BETWEEN/IN, AND/OR/NOT with the
// precedence OR < AND < NOT < comparisons/functions, the boolean functions
// (attribute_exists / attribute_not_exists / attribute_type / begins_with /
// contains), and the size() operand function. Document paths support nested
// maps and list indexes (a.b[0].c). Placeholders #n and :v are resolved
// against ExpressionAttributeNames / ExpressionAttributeValues.
//
// Items in MockCloud's store are kept already-unmarshalled (JS scalars and
// plain objects/arrays). Types for comparisons are therefore inferred from
// the JS value at evaluation time; for the :v side we preserve the original
// DynamoDB type descriptor so that begins_with / contains / attribute_type
// behave correctly when the SDK distinguishes S/N/B/SS/etc.

// ── Tokenizer ─────────────────────────────────────────────────────────────

const KEYWORDS = new Set(['AND', 'OR', 'NOT', 'BETWEEN', 'IN']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); i++; continue; }
    if (c === '.') { tokens.push({ t: 'dot' }); i++; continue; }
    if (c === '[') {
      let j = i + 1;
      while (j < src.length && src[j] !== ']') j++;
      if (j >= src.length) throw new Error('Unterminated list index');
      const n = src.slice(i + 1, j).trim();
      if (!/^\d+$/.test(n)) throw new Error(`Invalid list index: ${n}`);
      tokens.push({ t: 'index', v: Number(n) });
      i = j + 1;
      continue;
    }
    if (c === '=') { tokens.push({ t: 'cmp', v: '=' }); i++; continue; }
    if (c === '<') {
      if (src[i + 1] === '=') { tokens.push({ t: 'cmp', v: '<=' }); i += 2; continue; }
      if (src[i + 1] === '>') { tokens.push({ t: 'cmp', v: '<>' }); i += 2; continue; }
      tokens.push({ t: 'cmp', v: '<' }); i++; continue;
    }
    if (c === '>') {
      if (src[i + 1] === '=') { tokens.push({ t: 'cmp', v: '>=' }); i += 2; continue; }
      tokens.push({ t: 'cmp', v: '>' }); i++; continue;
    }
    if (c === '#') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'name_ph', v: src.slice(i, j) });
      i = j; continue;
    }
    if (c === ':') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: 'value_ph', v: src.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      const upper = w.toUpperCase();
      if (KEYWORDS.has(upper)) tokens.push({ t: 'kw', v: upper });
      else tokens.push({ t: 'ident', v: w });
      i = j; continue;
    }
    throw new Error(`Unexpected character in expression: ${c}`);
  }
  return tokens;
}

// ── Parser (Pratt-style) ──────────────────────────────────────────────────
//
// Grammar (precedence low → high):
//   expr        := or_expr
//   or_expr     := and_expr ( OR and_expr )*
//   and_expr    := not_expr ( AND not_expr )*
//   not_expr    := NOT not_expr | primary
//   primary     := '(' expr ')' | function_call | operand_expr
//   operand_expr:= operand ( cmp operand
//                          | BETWEEN operand AND operand
//                          | IN '(' operand (',' operand)* ')'
//                          )?
//   operand     := value_ph | size '(' path ')' | path
//   function_call := ident '(' arg (',' arg)* ')'  // boolean functions

const BOOL_FUNCS = new Set([
  'attribute_exists', 'attribute_not_exists', 'attribute_type',
  'begins_with', 'contains',
]);

function parse(tokens) {
  let pos = 0;
  const peek = (off = 0) => tokens[pos + off];
  const consume = () => tokens[pos++];
  const expect = (t, v) => {
    const tok = tokens[pos];
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`Expected ${t}${v ? ` "${v}"` : ''}, got ${tok ? JSON.stringify(tok) : 'EOF'}`);
    }
    pos++;
    return tok;
  };

  function parseExpr() { return parseOr(); }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'kw' && peek().v === 'OR') {
      consume();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().t === 'kw' && peek().v === 'AND') {
      consume();
      left = { type: 'and', left, right: parseNot() };
    }
    return left;
  }

  function parseNot() {
    if (peek() && peek().t === 'kw' && peek().v === 'NOT') {
      consume();
      return { type: 'not', expr: parseNot() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.t === 'lparen') {
      consume();
      const e = parseExpr();
      expect('rparen');
      return e;
    }
    // function-call form: ident '(' ...
    if (tok.t === 'ident' && peek(1) && peek(1).t === 'lparen' && BOOL_FUNCS.has(tok.v.toLowerCase())) {
      return parseFuncCall();
    }
    // Otherwise: operand-led comparison / BETWEEN / IN
    return parseComparison();
  }

  function parseFuncCall() {
    const name = consume().v.toLowerCase();
    expect('lparen');
    const args = [];
    if (!(peek() && peek().t === 'rparen')) {
      args.push(parseOperand());
      while (peek() && peek().t === 'comma') { consume(); args.push(parseOperand()); }
    }
    expect('rparen');
    return { type: 'func', name, args };
  }

  function parseOperand() {
    const tok = peek();
    if (!tok) throw new Error('Expected operand');
    if (tok.t === 'value_ph') { consume(); return { type: 'value', ph: tok.v }; }
    if (tok.t === 'ident' && tok.v.toLowerCase() === 'size'
        && peek(1) && peek(1).t === 'lparen') {
      consume(); consume();
      const inner = parsePath();
      expect('rparen');
      return { type: 'size', path: inner };
    }
    if (tok.t === 'ident' || tok.t === 'name_ph') {
      return parsePath();
    }
    throw new Error(`Unexpected operand token: ${JSON.stringify(tok)}`);
  }

  function parsePath() {
    const segs = [];
    const head = consume();
    if (head.t === 'name_ph') segs.push({ kind: 'name_ph', v: head.v });
    else if (head.t === 'ident') segs.push({ kind: 'attr', v: head.v });
    else throw new Error(`Expected path, got ${JSON.stringify(head)}`);
    while (peek()) {
      const nx = peek();
      if (nx.t === 'dot') {
        consume();
        const part = consume();
        if (part.t === 'name_ph') segs.push({ kind: 'name_ph', v: part.v });
        else if (part.t === 'ident') segs.push({ kind: 'attr', v: part.v });
        else throw new Error(`Expected path component after '.', got ${JSON.stringify(part)}`);
      } else if (nx.t === 'index') {
        consume();
        segs.push({ kind: 'index', v: nx.v });
      } else break;
    }
    return { type: 'path', segs };
  }

  function parseComparison() {
    const left = parseOperand();
    const nx = peek();
    if (!nx) return left;
    if (nx.t === 'cmp') {
      consume();
      const right = parseOperand();
      return { type: 'cmp', op: nx.v, left, right };
    }
    if (nx.t === 'kw' && nx.v === 'BETWEEN') {
      consume();
      const lo = parseOperand();
      expect('kw', 'AND');
      const hi = parseOperand();
      return { type: 'between', expr: left, lo, hi };
    }
    if (nx.t === 'kw' && nx.v === 'IN') {
      consume();
      expect('lparen');
      const list = [parseOperand()];
      while (peek() && peek().t === 'comma') { consume(); list.push(parseOperand()); }
      expect('rparen');
      return { type: 'in', expr: left, list };
    }
    return left;
  }

  const ast = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token at end: ${JSON.stringify(tokens[pos])}`);
  return ast;
}

// ── Typed-value helpers ───────────────────────────────────────────────────
//
// "TV" = { type: 'S'|'N'|'BOOL'|'NULL'|'L'|'M'|'SS'|'NS'|'BS'|'B', value }.
// For substituted :v values we preserve the original DynamoDB type code from
// the raw ExpressionAttributeValues map. For values pulled out of stored
// items we infer the type from the JS value (storage has already discarded
// the descriptor).

function tvFromDdb(ddb) {
  if (ddb == null || typeof ddb !== 'object') return null;
  if ('S'    in ddb) return { type: 'S',    value: ddb.S };
  if ('N'    in ddb) return { type: 'N',    value: Number(ddb.N) };
  if ('BOOL' in ddb) return { type: 'BOOL', value: !!ddb.BOOL };
  if ('NULL' in ddb) return { type: 'NULL', value: null };
  if ('B'    in ddb) return { type: 'B',    value: ddb.B };
  if ('SS'   in ddb) return { type: 'SS',   value: ddb.SS };
  if ('NS'   in ddb) return { type: 'NS',   value: ddb.NS.map(Number) };
  if ('BS'   in ddb) return { type: 'BS',   value: ddb.BS };
  if ('L'    in ddb) return { type: 'L',    value: ddb.L.map(tvFromDdb) };
  if ('M'    in ddb) {
    const m = {};
    for (const [k, v] of Object.entries(ddb.M)) m[k] = tvFromDdb(v);
    return { type: 'M', value: m };
  }
  return null;
}

function tvFromJs(v) {
  if (v === undefined) return undefined;
  if (v === null) return { type: 'NULL', value: null };
  if (typeof v === 'string')  return { type: 'S',    value: v };
  if (typeof v === 'number')  return { type: 'N',    value: v };
  if (typeof v === 'boolean') return { type: 'BOOL', value: v };
  if (Array.isArray(v))       return { type: 'L',    value: v.map(tvFromJs) };
  if (typeof v === 'object') {
    const m = {};
    for (const [k, val] of Object.entries(v)) m[k] = tvFromJs(val);
    return { type: 'M', value: m };
  }
  return { type: 'S', value: String(v) };
}

function resolveName(seg, names) {
  if (seg.kind === 'attr')    return seg.v;
  if (seg.kind === 'name_ph') {
    if (!names || !(seg.v in names)) throw new Error(`Unknown name placeholder ${seg.v}`);
    return names[seg.v];
  }
  throw new Error('Index segment cannot be resolved as a name');
}

// Walks a parsed path against the *raw JS item* (unmarshalled), then converts
// the landing value into a TV. Returns undefined if any segment is missing.
function resolvePath(path, item, names) {
  let cur = item;
  for (const seg of path.segs) {
    if (cur === undefined || cur === null) return undefined;
    if (seg.kind === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.v];
    } else {
      const name = resolveName(seg, names);
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = cur[name];
    }
  }
  return tvFromJs(cur);
}

function resolveOperand(node, ctx) {
  if (node.type === 'value') {
    if (!(node.ph in ctx.values)) throw new Error(`Unknown value placeholder ${node.ph}`);
    return ctx.values[node.ph];
  }
  if (node.type === 'path') {
    return resolvePath(node, ctx.item, ctx.names);
  }
  if (node.type === 'size') {
    const tv = resolvePath(node.path, ctx.item, ctx.names);
    if (tv === undefined) return undefined;
    const n = sizeOf(tv);
    return n === undefined ? undefined : { type: 'N', value: n };
  }
  throw new Error(`Unexpected operand AST: ${node.type}`);
}

function sizeOf(tv) {
  switch (tv.type) {
    case 'S':  return tv.value.length;
    case 'B':  return typeof tv.value === 'string' ? tv.value.length : 0;
    case 'L':  return tv.value.length;
    case 'M':  return Object.keys(tv.value).length;
    case 'SS':
    case 'NS':
    case 'BS': return tv.value.length;
    default:   return undefined;
  }
}

// AWS comparison rules: types must match; N compared numerically, S/B
// lexicographically. Mismatched types → false (never throws).
function compare(op, a, b) {
  if (a === undefined || b === undefined) return false;
  if (a.type !== b.type) return false;
  let cmp;
  if (a.type === 'N') cmp = a.value === b.value ? 0 : (a.value < b.value ? -1 : 1);
  else if (a.type === 'S' || a.type === 'B') cmp = a.value === b.value ? 0 : (a.value < b.value ? -1 : 1);
  else if (a.type === 'BOOL' || a.type === 'NULL') {
    if (op !== '=' && op !== '<>') return false;
    cmp = a.value === b.value ? 0 : 1;
  } else {
    // L / M / sets: equality only, by deep value compare.
    if (op !== '=' && op !== '<>') return false;
    cmp = deepEqualTv(a, b) ? 0 : 1;
  }
  switch (op) {
    case '=':  return cmp === 0;
    case '<>': return cmp !== 0;
    case '<':  return cmp < 0;
    case '<=': return cmp <= 0;
    case '>':  return cmp > 0;
    case '>=': return cmp >= 0;
  }
  return false;
}

function deepEqualTv(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'L') {
    if (a.value.length !== b.value.length) return false;
    for (let i = 0; i < a.value.length; i++) if (!deepEqualTv(a.value[i], b.value[i])) return false;
    return true;
  }
  if (a.type === 'M') {
    const ak = Object.keys(a.value), bk = Object.keys(b.value);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!(k in b.value) || !deepEqualTv(a.value[k], b.value[k])) return false;
    return true;
  }
  if (a.type === 'SS' || a.type === 'BS') {
    if (a.value.length !== b.value.length) return false;
    const bset = new Set(b.value);
    for (const x of a.value) if (!bset.has(x)) return false;
    return true;
  }
  if (a.type === 'NS') {
    if (a.value.length !== b.value.length) return false;
    const bset = new Set(b.value);
    for (const x of a.value) if (!bset.has(x)) return false;
    return true;
  }
  return a.value === b.value;
}

// ── Evaluator ─────────────────────────────────────────────────────────────

function evalAst(ast, ctx) {
  switch (ast.type) {
    case 'and': return evalAst(ast.left, ctx) && evalAst(ast.right, ctx);
    case 'or':  return evalAst(ast.left, ctx) || evalAst(ast.right, ctx);
    case 'not': return !evalAst(ast.expr, ctx);
    case 'cmp': {
      const a = resolveOperand(ast.left, ctx);
      const b = resolveOperand(ast.right, ctx);
      return compare(ast.op, a, b);
    }
    case 'between': {
      const v  = resolveOperand(ast.expr, ctx);
      const lo = resolveOperand(ast.lo,   ctx);
      const hi = resolveOperand(ast.hi,   ctx);
      return compare('>=', v, lo) && compare('<=', v, hi);
    }
    case 'in': {
      const v = resolveOperand(ast.expr, ctx);
      for (const c of ast.list) {
        const cv = resolveOperand(c, ctx);
        if (compare('=', v, cv)) return true;
      }
      return false;
    }
    case 'func': return evalFunc(ast, ctx);
  }
  throw new Error(`Unknown AST node: ${ast.type}`);
}

function evalFunc(node, ctx) {
  const [a0, a1] = node.args;
  switch (node.name) {
    case 'attribute_exists': {
      if (!a0 || a0.type !== 'path') throw new Error('attribute_exists requires a path');
      return resolvePath(a0, ctx.item, ctx.names) !== undefined;
    }
    case 'attribute_not_exists': {
      if (!a0 || a0.type !== 'path') throw new Error('attribute_not_exists requires a path');
      return resolvePath(a0, ctx.item, ctx.names) === undefined;
    }
    case 'attribute_type': {
      const v  = resolveOperand(a0, ctx);
      const tp = resolveOperand(a1, ctx);
      if (v === undefined || !tp || tp.type !== 'S') return false;
      return v.type === tp.value;
    }
    case 'begins_with': {
      const v = resolveOperand(a0, ctx);
      const p = resolveOperand(a1, ctx);
      if (!v || !p) return false;
      if ((v.type !== 'S' && v.type !== 'B') || v.type !== p.type) return false;
      return typeof v.value === 'string' && v.value.startsWith(p.value);
    }
    case 'contains': {
      const v = resolveOperand(a0, ctx);
      const t = resolveOperand(a1, ctx);
      if (!v || !t) return false;
      if (v.type === 'S' && t.type === 'S') return v.value.includes(t.value);
      if (v.type === 'L') return v.value.some(x => deepEqualTv(x, t));
      if (v.type === 'SS' || v.type === 'NS' || v.type === 'BS') {
        return v.value.some(x => x === t.value);
      }
      return false;
    }
  }
  throw new Error(`Unknown function: ${node.name}`);
}

// ── Public entry ──────────────────────────────────────────────────────────

const cache = new Map();
function compile(expr) {
  let ast = cache.get(expr);
  if (!ast) { ast = parse(tokenize(expr)); cache.set(expr, ast); }
  return ast;
}

// Build the values context from RAW (still type-descriptor-shaped)
// ExpressionAttributeValues so we keep type fidelity for the :v side.
function buildValues(rawExprValues) {
  const out = {};
  if (!rawExprValues) return out;
  for (const [k, v] of Object.entries(rawExprValues)) out[k] = tvFromDdb(v);
  return out;
}

// Evaluate a ConditionExpression. `item` is the unmarshalled stored item, or
// null if no item exists (attribute_not_exists on the key should return true).
// Returns true/false. Throws ValidationException-style Error on parse errors;
// the caller decides how to surface those.
export function evaluateCondition(expr, item, exprNames, rawExprValues) {
  if (!expr) return true;
  const ast = compile(expr);
  const ctx = {
    item: item || {},
    names: exprNames || {},
    values: buildValues(rawExprValues),
  };
  return evalAst(ast, ctx);
}

// Evaluate an arbitrary KeyConditionExpression or FilterExpression. Same grammar
// and engine as a ConditionExpression — boolean result against one item. An
// empty expression passes (used so callers can apply an optional filter
// uniformly). Throws on parse errors so the caller can surface a
// ValidationException.
export function evaluatePredicate(expr, item, exprNames, rawExprValues) {
  return evaluateCondition(expr, item, exprNames, rawExprValues);
}

// ── Projection ──────────────────────────────────────────────────────────────
//
// A ProjectionExpression is a comma-separated list of document paths. We parse
// each path with the same tokenizer/path-grammar used everywhere else, then
// build a pruned copy of the item containing only the referenced paths
// (preserving nested map / list structure). Unknown paths are simply omitted.

const projCache = new Map();
function compileProjection(expr) {
  let paths = projCache.get(expr);
  if (paths) return paths;
  const tokens = tokenize(expr);
  paths = [];
  let i = 0;
  const segsFor = () => {
    const segs = [];
    let tok = tokens[i];
    if (!tok || (tok.t !== 'ident' && tok.t !== 'name_ph')) {
      throw new Error('Invalid ProjectionExpression: expected attribute path');
    }
    segs.push(tok.t === 'name_ph' ? { kind: 'name_ph', v: tok.v } : { kind: 'attr', v: tok.v });
    i++;
    while (i < tokens.length) {
      tok = tokens[i];
      if (tok.t === 'dot') {
        i++;
        const part = tokens[i];
        if (!part || (part.t !== 'ident' && part.t !== 'name_ph')) {
          throw new Error('Invalid ProjectionExpression: expected name after "."');
        }
        segs.push(part.t === 'name_ph' ? { kind: 'name_ph', v: part.v } : { kind: 'attr', v: part.v });
        i++;
      } else if (tok.t === 'index') {
        segs.push({ kind: 'index', v: tok.v });
        i++;
      } else break;
    }
    return segs;
  };
  paths.push(segsFor());
  while (i < tokens.length) {
    if (tokens[i].t !== 'comma') throw new Error('Invalid ProjectionExpression: expected ","');
    i++;
    paths.push(segsFor());
  }
  projCache.set(expr, paths);
  return paths;
}

// Read the raw JS value at a parsed segment path; undefined if missing.
function getBySegs(item, segs, names) {
  let cur = item;
  for (const seg of segs) {
    if (cur === undefined || cur === null) return undefined;
    if (seg.kind === 'index') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg.v];
    } else {
      const name = resolveName(seg, names);
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = cur[name];
    }
  }
  return cur;
}

// Set a value into `out` along a segment path, materialising nested
// maps / arrays as needed.
function setBySegs(out, segs, value, names) {
  let cur = out;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const last = k === segs.length - 1;
    const keyOrIdx = seg.kind === 'index' ? seg.v : resolveName(seg, names);
    if (last) {
      cur[keyOrIdx] = value;
    } else {
      const nextIsIndex = segs[k + 1].kind === 'index';
      if (cur[keyOrIdx] === undefined || cur[keyOrIdx] === null) {
        cur[keyOrIdx] = nextIsIndex ? [] : {};
      }
      cur = cur[keyOrIdx];
    }
  }
}

// Return a pruned copy of `item` containing only the paths named in
// `projectionExpr`. If the expression is empty, return the item unchanged.
export function projectItem(item, projectionExpr, exprNames) {
  if (!projectionExpr) return item;
  const names = exprNames || {};
  const paths = compileProjection(projectionExpr);
  const out = {};
  for (const segs of paths) {
    const val = getBySegs(item, segs, names);
    if (val !== undefined) setBySegs(out, segs, val, names);
  }
  return out;
}

// Exported for potential reuse by Query / Scan FilterExpression later.
export const __test = { tokenize, parse, compile, tvFromJs, tvFromDdb, compileProjection };
