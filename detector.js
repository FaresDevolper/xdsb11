'use strict';

const { STRONG } = require('./words');

/** توحيد النص العربي: يشيل التشكيل والتطويل ويوحد الحروف المتشابهة */
function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '') // تشكيل + تطويل
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/گ/g, 'ك')
    .replace(/ک/g, 'ك')
    .replace(/ی/g, 'ي')
    .replace(/چ/g, 'ج')
    .replace(/پ/g, 'ب')
    .replace(/ڤ/g, 'ف')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** يدمج الحروف المكررة (شرمووووطة = شرموطه) */
function collapse(s) {
  return s.replace(/(.)\1+/gu, '$1');
}

function tokenize(text) {
  return String(text || '')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .map((orig) => ({ orig, norm: collapse(normalize(orig)) }))
    .filter((t) => t.norm.length > 0);
}

const PREFIXES = ['و', 'ف', 'ب', 'ل', 'ك', 'ال', 'وال', 'بال', 'لل', 'فال'];

function variants(norm) {
  const out = [norm];
  for (const p of PREFIXES) {
    if (norm.startsWith(p) && norm.length - p.length >= 3) out.push(norm.slice(p.length));
  }
  return out;
}

const ENTRIES = [...new Set(STRONG.map((w) => collapse(normalize(w))).filter(Boolean))].map((n) => ({
  norm: n,
  words: n.split(' '),
}));

const SINGLES = new Set(ENTRIES.filter((e) => e.words.length === 1).map((e) => e.norm));
const PHRASES = ENTRIES.filter((e) => e.words.length > 1);

/**
 * يرجع قائمة بالمخالفات الموجودة في النص:
 * [{ matched: 'الكلمة بعد التوحيد', said: 'الكلمة كما نُطقت' }]
 */
function findBadWords(text) {
  const tokens = tokenize(text);
  const hits = [];
  const used = new Set();

  // العبارات أولاً (أطول = أدق)
  for (const phrase of PHRASES) {
    const n = phrase.words.length;
    for (let i = 0; i + n <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        const tokVariants = j === 0 ? variants(tokens[i + j].norm) : [tokens[i + j].norm];
        if (!tokVariants.includes(phrase.words[j])) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hits.push({
          matched: phrase.norm,
          said: tokens.slice(i, i + n).map((t) => t.orig).join(' '),
        });
        for (let j = 0; j < n; j++) used.add(i + j);
      }
    }
  }

  // الكلمات المفردة
  tokens.forEach((t, i) => {
    if (used.has(i)) return;
    for (const v of variants(t.norm)) {
      if (SINGLES.has(v)) {
        hits.push({ matched: v, said: t.orig });
        break;
      }
    }
  });

  return hits;
}

module.exports = { normalize, collapse, findBadWords };
