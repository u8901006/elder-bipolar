#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/coding/paas/v4";
const MODEL_FALLBACK_CHAIN = ["glm-5-turbo", "glm-4.7", "glm-4.7-flash"];

const SYSTEM_PROMPT = `你是老年精神醫學領域的資深研究員與科學傳播者，專精老年躁鬱症（Older-Age Bipolar Disorder, OABD）。
你的任務是：
1. 從提供的醫學文獻中，篩選出與老年躁鬱症最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const TAG_OPTIONS = [
  "老年躁鬱症", "OABD", "晚發型躁症", "鋰鹽", "情緒穩定劑",
  "抗精神病藥物", "認知功能", "失智症", "腦影像", "生物標記",
  "發炎", "神經退化", "電痙攣治療", "心理治療", "心理教育",
  "自殺防治", "藥物安全", "多重心身疾病", "照護者", "社會決定因素",
  "長期照護", "住院", "復發預防", "睡眠與日夜節律", "生活品質",
  "功能評估", "精神藥理學", "神經科學", "老年精神醫學", "跨文化精神醫學",
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: "", output: "" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) opts.input = args[++i];
    else if (args[i] === "--output" && args[i + 1]) opts.output = args[++i];
    else if (args[i] === "--api-key" && args[i + 1]) opts.apiKey = args[++i];
  }
  opts.apiKey = opts.apiKey || process.env.ZHIPU_API_KEY || "";
  return opts;
}

function sanitizeJson(text) {
  let clean = text.trim();
  if (clean.startsWith("```")) {
    const firstNewline = clean.indexOf("\n");
    clean = firstNewline !== -1 ? clean.slice(firstNewline + 1) : clean.slice(3);
    clean = clean.replace(/```+\s*$/, "");
  }
  clean = clean.trim();
  try {
    return JSON.parse(clean);
  } catch {
    const jsonStart = clean.indexOf("{");
    const jsonEnd = clean.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(clean.slice(jsonStart, jsonEnd + 1));
      } catch {
        const fixed = clean.slice(jsonStart, jsonEnd + 1)
          .replace(/,\s*}/g, "}")
          .replace(/,\s*]/g, "]")
          .replace(/\\n/g, " ")
          .replace(/\t/g, " ");
        return JSON.parse(fixed);
      }
    }
    throw new Error("No valid JSON object found in response");
  }
}

async function callZhipuApi(apiKey, model, messages, maxTokens = 50000) {
  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      top_p: 0.9,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(480000),
  });

  if (resp.status === 429) {
    throw Object.assign(new Error("Rate limited"), { status: 429 });
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Taipei" });
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新老年躁鬱症 (OABD) 文獻（共 ${paperCount} 篇，其中新文獻 ${papersData.new_count || paperCount} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "老年躁鬱症": 3,
    "鋰鹽": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TAG_OPTIONS.join("、")}。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  for (const model of MODEL_FALLBACK_CHAIN) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const rawText = await callZhipuApi(apiKey, model, messages);
        const result = sanitizeJson(rawText);
        console.error(`[INFO] Analysis complete: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`);
        return result;
      } catch (err) {
        if (err.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited on ${model}, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (err.message.includes("JSON") || err.message.includes("parse")) {
          console.error(`[WARN] JSON parse failed on ${model} attempt ${attempt + 1}: ${err.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error(`[ERROR] ${model} failed: ${err.message}`);
        break;
      }
    }
  }

  console.error("[ERROR] All models and attempts failed");
  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Taipei" });
  const dateParts = dateStr.split("-");
  const dateDisplay = dateParts.length === 3
    ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
    : dateStr;

  const summary = analysis.market_summary || "";
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const totalCount = topPicks.length + allPapers.length;
  const usedModel = process.env.ZHIPU_MODEL || "glm-5-turbo";

  let topPicksHtml = "";
  for (const pick of topPicks) {
    const tagsHtml = (pick.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join("");
    const util = pick.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    const pico = pick.pico || {};
    const picoHtml = Object.keys(pico).length
      ? `<div class="pico-grid">
          <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escHtml(pico.population || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escHtml(pico.intervention || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escHtml(pico.comparison || "-")}</span></div>
          <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escHtml(pico.outcome || "-")}</span></div>
        </div>`
      : "";

    topPicksHtml += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${escHtml(String(pick.rank || ""))}</span>
            <span class="${utilityClass}">${escHtml(util)}實用性</span>
          </div>
          <h3>${escHtml(pick.title_zh || pick.title_en || "")}</h3>
          <p class="journal-source">${escHtml(pick.journal || "")} &middot; ${escHtml(pick.title_en || "")}</p>
          <p>${escHtml(pick.summary || "")}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escAttr(pick.url || "#")}" target="_blank" rel="noopener">閱讀原文 &rarr;</a>
          </div>
        </div>`;
  }

  let allPapersHtml = "";
  for (const paper of allPapers) {
    const tagsHtml = (paper.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join("");
    const util = paper.clinical_utility || "中";
    const utilityClass = util === "高" ? "utility-high" : util === "中" ? "utility-mid" : "utility-low";
    allPapersHtml += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="${utilityClass} utility-sm">${escHtml(util)}</span>
          </div>
          <h3>${escHtml(paper.title_zh || paper.title_en || "")}</h3>
          <p class="journal-source">${escHtml(paper.journal || "")}</p>
          <p>${escHtml(paper.summary || "")}</p>
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escAttr(paper.url || "#")}" target="_blank" rel="noopener">PubMed &rarr;</a>
          </div>
        </div>`;
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${escHtml(k)}</span>`).join("");
  let topicBarsHtml = "";
  if (Object.keys(topicDist).length) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHtml += `
            <div class="topic-row">
              <span class="topic-name">${escHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>老年躁鬱症研究日報 &middot; OABD Daily &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 老年躁鬱症 (OABD) 研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 120px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .links-banner { margin-top: 48px; display: flex; flex-direction: column; gap: 12px; animation: fadeUp 0.5s ease 0.4s both; }
  .banner-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .banner-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .banner-icon { font-size: 28px; flex-shrink: 0; }
  .banner-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .banner-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 80px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">&#x1F9E0;</div>
    <div class="header-text">
      <h1>&#x8001;&#x5E74;&#x8E81;&#x9B31;&#x75C7;&#x7814;&#x7A76;&#x65E5;&#x5831; &middot; OABD Daily</h1>
      <div class="header-meta">
        <span class="badge badge-date">&#x1F4C5; ${dateDisplay}</span>
        <span class="badge badge-count">&#x1F4CA; ${totalCount} &#x7BC7;&#x6587;&#x737B;</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>&#x1F4CB; &#x4ECA;&#x65E5;&#x6587;&#x737B;&#x8D8B;&#x52E2;</h2>
    <p class="summary-text">${escHtml(summary)}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">&#x2B50;</span>&#x4ECA;&#x65E5;&#x7CBE;&#x9078; TOP Picks</div>${topPicksHtml}</div>` : ""}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">&#x1F4DA;</span>&#x5176;&#x4ED6;&#x503C;&#x5F97;&#x95DC;&#x6CE8;&#x7684;&#x6587;&#x737B;</div>${allPapersHtml}</div>` : ""}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">&#x1F4CA;</span>&#x4E3B;&#x984C;&#x5206;&#x4F48;</div>${topicBarsHtml}</div>` : ""}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">&#x1F3F7;&#xFE0F;</span>&#x95DC;&#x9375;&#x5B57;</div><div class="keywords">${keywordsHtml}</div></div>` : ""}

  <div class="links-banner">
    <a href="https://www.leepsyclinic.com/" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#x1F3E5;</span>
      <span class="banner-name">&#x674E;&#x653F;&#x6D0B;&#x8EAB;&#x5FC3;&#x8A3A;&#x6240;&#x9996;&#x9801;</span>
      <span class="banner-arrow">&rarr;</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#x1F4E8;</span>
      <span class="banner-name">&#x8A02;&#x95B1;&#x96FB;&#x5B50;&#x5831;</span>
      <span class="banner-arrow">&rarr;</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#x2615;</span>
      <span class="banner-name">Buy Me a Coffee</span>
      <span class="banner-arrow">&rarr;</span>
    </a>
  </div>

  <footer>
    <span>&#x8CC7;&#x6599;&#x4F86;&#x6E90;&#xFF1A;PubMed &middot; &#x5206;&#x6790;&#x6A21;&#x578B;&#xFF1A;${escHtml(usedModel)}</span>
    <span><a href="https://github.com/u8901006/elder-bipolar">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main() {
  const opts = parseArgs();
  if (!opts.apiKey) {
    console.error("[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key");
    process.exit(1);
  }
  if (!opts.input || !opts.output) {
    console.error("[ERROR] --input and --output are required");
    process.exit(1);
  }

  const papersData = JSON.parse(readFileSync(opts.input, "utf8"));
  let analysis;

  if (!papersData.papers?.length) {
    console.error("[WARN] No papers found, generating empty report");
    analysis = {
      date: papersData.date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Taipei" }),
      market_summary: "今日 PubMed 暫無新的老年躁鬱症 (OABD) 文獻更新。請明天再查看。",
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(opts.apiKey, papersData);
    if (!analysis) {
      console.error("[ERROR] Analysis failed");
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(opts.output) || ".", { recursive: true });
  writeFileSync(opts.output, html, "utf8");
  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
