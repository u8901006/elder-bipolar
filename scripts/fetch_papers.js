#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";

const PUBMED_SEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const JOURNALS = [
  "Bipolar Disord",
  "Int J Bipolar Disord",
  "J Affect Disord",
  "Am J Geriatr Psychiatry",
  "Int J Geriatr Psychiatry",
  "Int Psychogeriatr",
  "J Geriatr Psychiatry Neurol",
  "Psychogeriatrics",
  "Am J Psychiatry",
  "JAMA Psychiatry",
  "Lancet Psychiatry",
  "World Psychiatry",
  "Br J Psychiatry",
  "Acta Psychiatr Scand",
  "Psychol Med",
  "Eur Psychiatry",
  "Asian J Psychiatry",
  "BMC Psychiatry",
  "Front Psychiatry",
  "Psychiatry Res",
  "Biol Psychiatry",
  "Transl Psychiatry",
  "Mol Psychiatry",
  "Neuropsychopharmacology",
  "J Clin Psychiatry",
  "CNS Drugs",
  "Aging Ment Health",
  "Age Ageing",
  "Dement Geriatr Cogn Disord",
  "J Neurol Neurosurg Psychiatry",
  "Sleep",
  "Suicide Life Threat Behav",
];

const BIPOLAR_QUERY = [
  '"Bipolar Disorder"[Mesh]',
  '"bipolar disorder*"[tiab]',
  '"bipolar depression"[tiab]',
  "mania[tiab]",
  "manic[tiab]",
  "hypomania[tiab]",
  "hypomanic[tiab]",
  '"secondary mania"[tiab]',
  '"vascular mania"[tiab]',
  "cyclothymia[tiab]",
  "bipolarity[tiab]",
].join(" OR ");

const AGING_QUERY = [
  '"Aged"[Mesh]',
  '"Aged, 80 and over"[Mesh]',
  "elderly[tiab]",
  "geriatric[tiab]",
  '"older adult*"[tiab]',
  '"late-life"[tiab]',
  '"late life"[tiab]',
  '"old age"[tiab]',
  '"older age"[tiab]',
  "ageing[tiab]",
  "aging[tiab]",
  "aged[tiab]",
  "OABD[tiab]",
  '"older-age bipolar disorder"[tiab]',
  '"late-life bipolar disorder"[tiab]',
  '"geriatric bipolar disorder"[tiab]',
].join(" OR ");

function buildQuery(days) {
  const since = new Date(Date.now() - days * 86400000);
  const dateStr = `${since.getFullYear()}/${String(since.getMonth() + 1).padStart(2, "0")}/${String(since.getDate()).padStart(2, "0")}`;
  return `(${BIPOLAR_QUERY}) AND (${AGING_QUERY}) AND "${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: "papers.json" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) opts.days = parseInt(args[++i], 10);
    else if (args[i] === "--max-papers" && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function loadSeenPmids() {
  const path = process.env.SEEN_PMIDS_PATH || "docs/seen_pmids.json";
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return new Set(data.pmids || []);
    } catch {
      return new Set();
    }
  }
  return new Set();
}

async function searchPapers(query, retmax) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "OABD-Bot/1.0 (research aggregator)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`PubMed search HTTP ${resp.status}`);
  const data = await resp.json();
  return data.esearchresult?.idlist || [];
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(",")}&retmode=xml`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "OABD-Bot/1.0 (research aggregator)" },
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`PubMed fetch HTTP ${resp.status}`);
  const xml = await resp.text();
  return parseXmlArticles(xml);
}

function parseXmlArticles(xml) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xml)) !== null) {
    const block = match[1];
    const pmid = extractTag(block, "<PMID[^>]*>", "</PMID>") || "";
    const title = extractTag(block, "<ArticleTitle>", "</ArticleTitle>") || "";
    const journal = extractTag(block, "<Title>", "</Title>") || "";
    const abstract = extractAbstract(block);
    const dateStr = extractDate(block);
    const keywords = extractKeywords(block);
    const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "";
    papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
  }
  return papers;
}

function extractTag(block, openTag, closeTag) {
  const start = block.indexOf(openTag);
  if (start === -1) return "";
  const contentStart = block.indexOf(">", start) + 1;
  const end = block.indexOf(closeTag, contentStart);
  if (end === -1) return "";
  return block.slice(contentStart, end).replace(/<[^>]+>/g, "").trim();
}

function extractAbstract(block) {
  const parts = [];
  const absRegex = /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
  let m;
  while ((m = absRegex.exec(block)) !== null) {
    const label = m[1];
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text) parts.push(label ? `${label}: ${text}` : text);
  }
  if (!parts.length) {
    const simpleRegex = /<AbstractText>([\s\S]*?)<\/AbstractText>/g;
    while ((m = simpleRegex.exec(block)) !== null) {
      const text = m[1].replace(/<[^>]+>/g, "").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(" ").slice(0, 2000);
}

function extractDate(block) {
  const year = extractTag(block, "<Year>", "</Year>");
  const month = extractTag(block, "<Month>", "</Month>");
  const day = extractTag(block, "<Day>", "</Day>");
  return [year, month, day].filter(Boolean).join(" ");
}

function extractKeywords(block) {
  const kws = [];
  const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
  let m;
  while ((m = kwRegex.exec(block)) !== null) {
    const t = m[1].trim();
    if (t) kws.push(t);
  }
  return kws;
}

async function main() {
  const opts = parseArgs();
  const seenPmids = loadSeenPmids();
  const query = buildQuery(opts.days);

  console.error(`[INFO] Searching PubMed for OABD papers from last ${opts.days} days...`);
  let pmids = await searchPapers(query, opts.maxPapers);
  console.error(`[INFO] Found ${pmids.length} PMIDs`);

  if (!pmids.length) {
    const tz = new Date().toLocaleString("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
    const dateStr = tz;
    const empty = { date: dateStr, count: 0, new_count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(empty, null, 2));
    console.error("[INFO] No papers found");
    return;
  }

  const allPapers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${allPapers.length} papers`);

  const newPapers = allPapers.filter((p) => !seenPmids.has(p.pmid));
  console.error(`[INFO] New (unsampled) papers: ${newPapers.length} / ${allPapers.length}`);

  const tz = new Date().toLocaleString("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
  const output = {
    date: tz,
    count: allPapers.length,
    new_count: newPapers.length,
    papers: newPapers.length > 0 ? newPapers : allPapers,
  };

  writeFileSync(opts.output, JSON.stringify(output, null, 2));
  console.error(`[INFO] Saved to ${opts.output}`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
