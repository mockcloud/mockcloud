// services/dynamodb/update.js — DynamoDB UpdateExpression engine.
//
// Implements the four update clauses, in any order:
//   SET    path = operand [, ...]
//   REMOVE path [, ...]
//   ADD    path value [, ...]        (numbers add; sets union)
//   DELETE path value [, ...]        (sets difference)
//
// SET operands support arithmetic (a = a + :n, a = a - :n), the functions
// if_not_exists(path, operand) and list_append(op, op), placeholders :v, and
// document paths (nested maps + list indexes a.b[0].c). Names use #n.
//
// Items in MockCloud's store are unmarshalled JS. We therefore operate on JS
// values; raw ExpressionAttributeValues are unmarshalled to JS for the value
// side, while the original DynamoDB descriptor is consulted only to tell a Set
// (SS/NS/BS) apart from a List for ADD/DELETE semantics.

// ── Tokenizer (update grammar) ──────────────────────────────────────────────

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
    if (c === '=') { tokens.push({ t: 'eq' }); i++; continue; }
    if (c === '+') { tokens.push({ t: 'plus' }); i++; continue; }
    if (c === '-') { tokens.push({ t: 'minus' }); i++; continue; }
    if (c === '[') {
      let j = i + 1;
      while (j < src.length && src[j] !== ']') j++;
      if (j >= src.length) throw new Error('Unterminated list index');
      const n = src.slice(i + 1, j).trim();
      if (!/^\d+$/.test(n)) throw new Error(`Invalid list index: ${n}`);
      tokens.push({ t: 'index', v: Number(n) });
      i = j + 1; continue;
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
      tokens.push({ t: 'ident', v: src.slice(i, j) });
      i = j; continue;
    }
    throw new Error(`Unexpected character in UpdateExpression: ${c}`);
  }
  return tokens;
}

// ── Clause splitting ────────────────────────────────────────────────────────

const CLAUSES = ['SET', 'REMOVE', 'ADD', 'DELETE'];

// Split the raw expression into { SET: '...', REMOVE: '...', ... } by locating
// the clause keywords as whole words (case-insensitive).
function splitClauses(expr) {
  const out = {};
  const re = /\b(SET|REMOVE|ADD|DELETE)\b/gi;
  const marks = [];
  let m;
  while ((m = re.exec(expr)) !== null) {
    marks.push({ kw: m[1].toUpperCase(), start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let k = 0; k < marks.length; k++) {
    const end = k + 1 < marks.length ? marks[k + 1].start : expr.length;
    out[marks[k].kw] = expr.slice(marks[k].bodyStart, end).trim();
  }
  return out;
}

// ── Path helpers (operate on JS items) ──────────────────────────────────────

function resolveName(seg, names) {
  if (seg.kind === 'attr') return seg.v;
  if (seg.kind === 'name_ph') {
    if (!names || !(seg.v in names)) throw new Error(`Unknown name placeholder ${seg.v}`);
    return names[seg.v];
  }
  throw new Error('Index segment is not a name');
}

function getPath(item, segs, names) {
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

function setPath(item, segs, value, names) {
  let cur = item;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const last = k === segs.length - 1;
    const key = seg.kind === 'index' ? seg.v : resolveName(seg, names);
    if (last) { cur[key] = value; return; }
    const nextIsIndex = segs[k + 1].kind === 'index';
    if (cur[key] === undefined || cur[key] === null) cur[key] = nextIsIndex ? [] : {};
    cur = cur[key];
  }
}

function removePath(item, segs, names) {
  let cur = item;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const last = k === segs.length - 1;
    const key = seg.kind === 'index' ? seg.v : resolveName(seg, names);
    if (cur === undefined || cur === null) return;
    if (last) {
      if (seg.kind === 'index') { if (Array.isArray(cur)) cur.splice(key, 1); }
      else if (typeof cur === 'object') delete cur[key];
      return;
    }
    cur = cur[key];
  }
}

// ── Token-stream parser ─────────────────────────────────────────────────────
//
// We parse each clause body into actions. Reusable cursor over a token array.

function makeCursor(tokens) {
  let pos = 0;
  return {
    peek: (o = 0) => tokens[pos + o],
    next: () => tokens[pos++],
    eof: () => pos >= tokens.length,
    expect(t) {
      const tok = tokens[pos];
      if (!tok || tok.t !== t) throw new Error(`Expected ${t}, got ${tok ? tok.t : 'EOF'}`);
      return tokens[pos++];
    },
  };
}

function parsePath(cur) {
  const segs = [];
  const head = cur.next();
  if (!head) throw new Error('Expected path');
  if (head.t === 'name_ph') segs.push({ kind: 'name_ph', v: head.v });
  else if (head.t === 'ident') segs.push({ kind: 'attr', v: head.v });
  else throw new Error(`Expected path, got ${head.t}`);
  while (!cur.eof()) {
    const nx = cur.peek();
    if (nx.t === 'dot') {
      cur.next();
      const part = cur.next();
      if (part.t === 'name_ph') segs.push({ kind: 'name_ph', v: part.v });
      else if (part.t === 'ident') segs.push({ kind: 'attr', v: part.v });
      else throw new Error('Expected name after "."');
    } else if (nx.t === 'index') {
      cur.next();
      segs.push({ kind: 'index', v: nx.v });
    } else break;
  }
  return segs;
}

// ── SET operand evaluation ──────────────────────────────────────────────────
//
// operand := term (('+' | '-') term)?
// term    := value_ph | path | if_not_exists(path, operand) | list_append(op, op)

function evalOperand(cur, item, names, vals) {
  let left = evalTerm(cur, item, names, vals);
  const nx = cur.peek();
  if (nx && (nx.t === 'plus' || nx.t === 'minus')) {
    cur.next();
    const right = evalTerm(cur, item, names, vals);
    const a = Number(left), b = Number(right);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      throw new Error('Arithmetic on non-numeric operand in UpdateExpression');
    }
    return nx.t === 'plus' ? a + b : a - b;
  }
  return left;
}

function evalTerm(cur, item, names, vals) {
  const tok = cur.peek();
  if (!tok) throw new Error('Expected operand in SET');
  if (tok.t === 'value_ph') {
    cur.next();
    if (!(tok.v in vals)) throw new Error(`Unknown value placeholder ${tok.v}`);
    return vals[tok.v].js;
  }
  if (tok.t === 'ident' && cur.peek(1) && cur.peek(1).t === 'lparen') {
    const fn = tok.v.toLowerCase();
    if (fn === 'if_not_exists') {
      cur.next(); cur.next(); // ident, lparen
      const segs = parsePath(cur);
      cur.expect('comma');
      const fallback = evalOperand(cur, item, names, vals);
      cur.expect('rparen');
      const existing = getPath(item, segs, names);
      return existing === undefined ? fallback : existing;
    }
    if (fn === 'list_append') {
      cur.next(); cur.next();
      const a = evalOperand(cur, item, names, vals);
      cur.expect('comma');
      const b = evalOperand(cur, item, names, vals);
      cur.expect('rparen');
      const la = Array.isArray(a) ? a : (a === undefined ? [] : [a]);
      const lb = Array.isArray(b) ? b : (b === undefined ? [] : [b]);
      return [...la, ...lb];
    }
    throw new Error(`Unknown function in SET: ${fn}`);
  }
  // path
  const segs = parsePath(cur);
  return getPath(item, segs, names);
}

// ── Set helpers for ADD / DELETE ────────────────────────────────────────────

function asArray(v) { return Array.isArray(v) ? v.slice() : []; }
function unionSet(a, b) {
  const out = asArray(a);
  for (const x of b) if (!out.some(y => eq(y, x))) out.push(x);
  return out;
}
function diffSet(a, b) { return asArray(a).filter(x => !b.some(y => eq(y, x))); }
function eq(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }

// ── Public entry ────────────────────────────────────────────────────────────
//
// applyUpdate(oldItem, updateExpr, exprNames, rawValues, jsValues)
//   oldItem   — current stored item (JS) or null
//   updateExpr— the UpdateExpression string
//   exprNames — ExpressionAttributeNames map (#n → real name)
//   rawValues — raw ExpressionAttributeValues (type-descriptor shaped) — used
//               to distinguish sets from lists for ADD/DELETE
//   jsValues  — the same values unmarshalled to JS
//
// Returns { item, changed } where `item` is the new image (a fresh object) and
// `changed` is the array of top-level attribute names touched (for ReturnValues
// UPDATED_OLD / UPDATED_NEW).
export function applyUpdate(oldItem, updateExpr, exprNames, rawValues, jsValues) {
  const names = exprNames || {};
  const vals = {};
  for (const [k, v] of Object.entries(jsValues || {})) {
    const raw = rawValues ? rawValues[k] : undefined;
    const isSet = !!(raw && ('SS' in raw || 'NS' in raw || 'BS' in raw));
    // Storage is unmarshalled JS and the generic unmarshal() does not handle
    // set descriptors — extract the members array here so ADD/DELETE see an
    // array. (Sets degrade to lists in the lossy Phase-1 storage model.)
    let js = v;
    if (isSet) {
      if ('SS' in raw) js = raw.SS.slice();
      else if ('NS' in raw) js = raw.NS.map(Number);
      else js = raw.BS.slice();
    }
    vals[k] = { js, raw, isSet };
  }

  const item = oldItem ? structuredCloneSafe(oldItem) : {};
  const changed = new Set();
  const clauses = splitClauses(updateExpr || '');

  if (clauses.SET) {
    const cur = makeCursor(tokenize(clauses.SET));
    while (!cur.eof()) {
      const segs = parsePath(cur);
      cur.expect('eq');
      const value = evalOperand(cur, item, names, vals);
      setPath(item, segs, value, names);
      changed.add(topName(segs, names));
      if (!cur.eof()) cur.expect('comma');
    }
  }

  if (clauses.REMOVE) {
    const cur = makeCursor(tokenize(clauses.REMOVE));
    while (!cur.eof()) {
      const segs = parsePath(cur);
      removePath(item, segs, names);
      changed.add(topName(segs, names));
      if (!cur.eof()) cur.expect('comma');
    }
  }

  if (clauses.ADD) {
    const cur = makeCursor(tokenize(clauses.ADD));
    while (!cur.eof()) {
      const segs = parsePath(cur);
      const tok = cur.expect('value_ph');
      if (!(tok.v in vals)) throw new Error(`Unknown value placeholder ${tok.v}`);
      const operand = vals[tok.v];
      const existing = getPath(item, segs, names);
      if (operand.isSet) {
        setPath(item, segs, unionSet(existing, operand.js), names);
      } else {
        const base = existing === undefined ? 0 : Number(existing);
        setPath(item, segs, base + Number(operand.js), names);
      }
      changed.add(topName(segs, names));
      if (!cur.eof()) cur.expect('comma');
    }
  }

  if (clauses.DELETE) {
    const cur = makeCursor(tokenize(clauses.DELETE));
    while (!cur.eof()) {
      const segs = parsePath(cur);
      const tok = cur.expect('value_ph');
      if (!(tok.v in vals)) throw new Error(`Unknown value placeholder ${tok.v}`);
      const operand = vals[tok.v];
      const existing = getPath(item, segs, names);
      const result = diffSet(existing, operand.js);
      if (result.length === 0) removePath(item, segs, names);
      else setPath(item, segs, result, names);
      changed.add(topName(segs, names));
      if (!cur.eof()) cur.expect('comma');
    }
  }

  return { item, changed: [...changed] };
}

function topName(segs, names) {
  return segs[0].kind === 'index' ? null : resolveName(segs[0], names);
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}
