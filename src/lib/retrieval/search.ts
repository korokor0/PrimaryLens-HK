/**
 * Character-bigram TF-IDF retrieval — ~60 lines, no library, no embeddings (CLAUDE.md §5.5).
 *
 * Why bigrams: Chinese is not whitespace-delimited, so word tokenisation would need a
 * segmenter. Overlapping character bigrams ("小班教學" -> 小班, 班教, 教學) need none and still
 * capture term adjacency.
 *
 * Why IDF: plain overlap counting over-ranks ubiquitous terms — 教育, 學校 and 小學 appear on
 * nearly every page in this corpus, so without IDF every query would retrieve everything.
 * BM25 was rejected: its length normalisation buys little when chunking already bounds
 * passages to ~600 characters, and it adds two tuning parameters that cannot be justified
 * against a corpus this small.
 */
import type { Chunk, Index } from '../store/types.ts';

/** CJK: tokenised as overlapping bigrams, because there are no word boundaries to use. */
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Latin/digits: tokenised as whole words, because they already carry boundaries. */
const WORD_CHAR = /[a-zA-Z0-9]/u;

/**
 * English function words carry no topical signal, but IDF cannot know that: in a corpus that
 * is almost entirely Traditional Chinese they are *rare*, so they score as highly informative.
 * Calibration caught it — "What is the capital of France?" scored 0.53 on the strength of
 * "is", "the" and "of" alone, while its actual content words were absent. Dropped explicitly.
 */
const LATIN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'has',
  'have', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'that', 'the', 'this',
  'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

/**
 * Mixed tokeniser: character bigrams for CJK, whole words for Latin and digits.
 *
 * §5.5 specifies character bigrams, which is right for Chinese. Applying them to Latin text
 * turned out to be actively harmful, and calibration caught it: two-letter fragments of
 * "How do I cook pasta?" matched the English publication titles inside the 參考資料 page well
 * enough to score 1.43 — above every genuinely covered Chinese question. Two-letter Latin
 * fragments are near-universal in English, so they manufacture matches out of nothing.
 *
 * Treating a Latin run as one token means "cook" and "pasta" must genuinely appear. The
 * corpus is Traditional Chinese, so an English question about cooking now correctly finds
 * nothing and receives the §5.7 scope message — which is the honest answer, not a failure.
 */
export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFC').toLowerCase();
  const out: string[] = [];
  let i = 0;

  while (i < normalized.length) {
    const char = normalized[i];
    if (char === undefined) break;

    if (CJK_CHAR.test(char)) {
      let end = i;
      while (end < normalized.length && CJK_CHAR.test(normalized[end] ?? '')) end += 1;
      const run = normalized.slice(i, end);
      if (run.length === 1) out.push(run);
      else for (let k = 0; k + 1 < run.length; k += 1) out.push(run.slice(k, k + 2));
      i = end;
      continue;
    }

    if (WORD_CHAR.test(char)) {
      let end = i;
      while (end < normalized.length && WORD_CHAR.test(normalized[end] ?? '')) end += 1;
      const word = normalized.slice(i, end);
      if (word.length >= 2 && !LATIN_STOPWORDS.has(word)) out.push(word);
      i = end;
      continue;
    }

    i += 1; // punctuation and whitespace contribute no token
  }

  return out;
}

function countBigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const bigram of tokenize(text)) counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  return counts;
}

/**
 * Build the IDF table over all chunks. `ln(1 + N/df)` stays positive even for a bigram that
 * appears in every chunk, so a ubiquitous term is heavily discounted but never negative.
 */
export function buildIndex(chunks: Chunk[]): Index {
  const documentFrequency = new Map<string, number>();
  for (const chunk of chunks) {
    for (const bigram of new Set(tokenize(`${chunk.heading}\n${chunk.text}`))) {
      documentFrequency.set(bigram, (documentFrequency.get(bigram) ?? 0) + 1);
    }
  }

  const total = Math.max(chunks.length, 1);
  const idf: Record<string, number> = {};
  for (const [bigram, df] of documentFrequency) idf[bigram] = Math.log(1 + total / df);

  return { builtAt: new Date().toISOString(), chunks, idf, chunkCount: chunks.length };
}

export interface SearchHit {
  sourceId: string;
  title: string;
  url: string;
  heading: string;
  snippet: string;
  score: number;
}

/** Heading words describe the whole passage, so a hit there counts for more than one in the body. */
const HEADING_BONUS = 0.5;
/** The full query appearing verbatim is the strongest signal available without embeddings. */
const PHRASE_BONUS = 0.15;
const SNIPPET_CHARS = 220;

/**
 * A passage must match at least this many distinct query terms to count as evidence at all
 * (or every term, for queries shorter than that).
 *
 * This is the single most effective discriminator found during calibration, and it beat
 * tuning the scoring weights. A passage matching one common term looks superficially relevant
 * — 醫院排隊時間 scored 0.12 purely on 時間 — but one term in common is not evidence. Requiring
 * three collapsed every off-topic query in the calibration set to exactly 0.000 while leaving
 * all 27 covered and single-topic queries untouched. Four was too strict and began rejecting
 * genuine questions.
 */
const MIN_DISTINCT_MATCHES = 3;

/**
 * Below this score, application code returns the deterministic not-found response and the
 * model is never asked to write an answer (CLAUDE.md §5.6 step 5).
 *
 * Calibrated, not guessed — but a PoC heuristic, not an evaluated metric. Measured over 27
 * covered/single-topic questions and 14 unrelated ones against this 114-chunk corpus:
 * weakest covered 0.149, weakest partially-supported 0.145, highest unrelated 0.000.
 * 0.10 sits below every genuine question with headroom and above everything off-topic.
 * A different corpus would need re-calibrating; see docs/AI_LOG.md for the measurements.
 */
export const NO_EVIDENCE_THRESHOLD = 0.1;

/**
 * Score every chunk and return the best ones.
 *
 * The score is **matched IDF mass over total query IDF mass**: of everything informative the
 * query asked for, how much does this passage actually contain? That ratio, not a raw sum, is
 * what makes one fixed no-evidence threshold possible.
 *
 * Calibration showed why a raw sum cannot work here. Summed tf x idf ranked "How do I cook
 * pasta?" (5.45) and a prompt-injection string (7.53) above genuinely covered questions like
 * 「一條龍」辦學模式是甚麼？ (3.98): rare Latin bigrams matched English publication titles in the
 * corpus, and IDF rewards rarity. Dividing by query length did not help, because it still
 * ignored how much of the query went unmatched. Charging every unmatched bigram the IDF of a
 * maximally rare term does, so an off-topic query is penalised for what it fails to match.
 *
 * Each term's contribution saturates at its own IDF, via tf/(tf+1). That bounds the ratio to
 * [0,1] and is what makes it a true coverage measure. Logarithmic damping was not enough:
 * 醫院排隊時間 matched only 時間, yet repetition let that single term earn 2.8x its own weight
 * and claim 40% coverage. A term can now never contribute more than it is worth.
 */
export function search(index: Index, query: string, limit = 5): SearchHit[] {
  const queryBigrams = countBigrams(query);
  if (queryBigrams.size === 0) return [];

  const phrase = query.normalize('NFC').toLowerCase().trim();
  // A bigram absent from the corpus is treated as maximally informative, as if it occurred in
  // exactly one chunk. That is the same scale buildIndex uses, so the ratio stays comparable.
  const idfUnseen = Math.log(1 + Math.max(index.chunkCount, 1));

  let totalIdf = 0;
  for (const bigram of queryBigrams.keys()) totalIdf += index.idf[bigram] ?? idfUnseen;
  if (totalIdf === 0) return [];

  const scored = index.chunks.map((chunk) => {
    const bodyCounts = countBigrams(chunk.text);
    const headingCounts = countBigrams(chunk.heading);

    let matched = 0;
    let distinctMatches = 0;
    for (const bigram of queryBigrams.keys()) {
      const idf = index.idf[bigram];
      if (idf === undefined) continue;
      const weight = (bodyCounts.get(bigram) ?? 0) + (headingCounts.get(bigram) ?? 0) * HEADING_BONUS;
      if (weight <= 0) continue;
      matched += idf * (weight / (weight + 1));
      distinctMatches += 1;
    }

    // Too little overlap to be evidence, however well the arithmetic scores.
    if (distinctMatches < Math.min(MIN_DISTINCT_MATCHES, queryBigrams.size)) {
      return { chunk, score: 0 };
    }

    let score = matched / totalIdf;
    if (phrase.length >= 2 && chunk.text.toLowerCase().includes(phrase)) score += PHRASE_BONUS;

    return { chunk, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      sourceId: chunk.sourceId,
      title: chunk.title,
      url: chunk.url,
      heading: chunk.heading,
      snippet: chunk.text.length > SNIPPET_CHARS ? `${chunk.text.slice(0, SNIPPET_CHARS)}…` : chunk.text,
      score: Number(score.toFixed(4)),
    }));
}
