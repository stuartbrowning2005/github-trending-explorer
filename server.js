require("dotenv").config();

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const { GITHUB_TOKEN, CLAUDE_API_KEY } = process.env;

const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

const app = express();
const PORT = 3001;

app.use(express.static("public"));

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

async function fetchTrendingRepos(page, keyword) {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceStr = since.toISOString().split("T")[0];

  let query = `stars:>100 created:>${sinceStr}`;
  if (keyword) {
    query = `${keyword} in:name,description,topics ${query}`;
  }
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query
  )}&sort=stars&order=desc&per_page=10&page=${page}`;

  console.log(`[trending] fetching page ${page} with query: ${query}`);
  const res = await fetch(url, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub search API failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  console.log(`[trending] found ${data.items.length} repos on page ${page}`);
  return data.items;
}

async function fetchReadme(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/readme`;
  const res = await fetch(url, {
    headers: { ...GITHUB_HEADERS, Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) {
    console.log(`[readme] no README found for ${owner}/${repo} (${res.status})`);
    return null;
  }
  return res.text();
}

async function summarizeReadme(fullName, readmeText) {
  console.log(`[summary] generating summary for ${fullName}`);
  const truncated = readmeText.slice(0, 12000);
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `Here is the README for the GitHub repository "${fullName}":\n\n${truncated}\n\nProduce two things about this repo:\n\n1. "headline": A plain-language, product-minded title of what the repo lets you DO. Max 8 words. No jargon, no repo name. Think Product Hunt tagline. Example: for an Amazon fake-brand filter, "Catch fake Amazon brands automatically."\n\n2. "summary": You're texting a developer friend about a trending GitHub repo. In ONE sentence, max 25 words, tell them what it is and whether it's actually interesting. Be blunt and casual — the way you'd text, not a product description. You're allowed to be dismissive if it's derivative ('another X, but nothing special') and hyped if it's genuinely cool. No marketing voice, no 'this project,' no hedging, no markdown. Just the take.\n\nRespond with ONLY a JSON object in this exact shape, no markdown fences, no preamble: {"headline": "...", "summary": "..."}`,
      },
    ],
  });
  const textBlock = message.content.find((block) => block.type === "text");
  if (!textBlock) {
    return { headline: null, summary: null };
  }

  const raw = textBlock.text.trim();
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    return {
      headline: typeof parsed.headline === "string" ? parsed.headline.trim() : null,
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : null,
    };
  } catch (err) {
    console.log(`[summary] failed to parse JSON for ${fullName}: ${err.message}`);
    return { headline: null, summary: raw };
  }
}

app.get("/api/trending", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const keyword = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const repos = await fetchTrendingRepos(page, keyword);

    const results = await Promise.all(
      repos.map(async (repo) => {
        const base = {
          name: repo.full_name,
          url: repo.html_url,
          stars: repo.stargazers_count,
          language: repo.language,
          description: repo.description,
        };

        try {
          const [owner, name] = repo.full_name.split("/");
          const readme = await fetchReadme(owner, name);
          if (!readme) {
            return { ...base, headline: null, summary: null };
          }
          const { headline, summary } = await summarizeReadme(repo.full_name, readme);
          console.log(`[trending] done: ${repo.full_name}`);
          return { ...base, headline: headline || repo.full_name, summary };
        } catch (err) {
          console.log(`[trending] failed to summarize ${repo.full_name}: ${err.message}`);
          return { ...base, headline: repo.full_name, summary: null };
        }
      })
    );

    console.log("[trending] request complete");
    res.json(results);
  } catch (err) {
    console.error(`[trending] request failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
