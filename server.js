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

const WINDOW_OPTIONS_DAYS = [3, 7, 14, 30];
const LANGUAGE_OPTIONS = [
  null,
  "JavaScript",
  "TypeScript",
  "Python",
  "Go",
  "Rust",
  "Java",
  "C++",
];

function pickRandom(options) {
  return options[Math.floor(Math.random() * options.length)];
}

async function fetchTrendingRepos() {
  const windowDays = pickRandom(WINDOW_OPTIONS_DAYS);
  const language = pickRandom(LANGUAGE_OPTIONS);

  const since = new Date();
  since.setDate(since.getDate() - windowDays);
  const sinceStr = since.toISOString().split("T")[0];

  let query = `stars:>100 created:>${sinceStr}`;
  if (language) {
    query += ` language:${language}`;
  }
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(
    query
  )}&sort=stars&order=desc&per_page=10`;

  console.log(`[trending] fetching top repos with query: ${query}`);
  const res = await fetch(url, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub search API failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  console.log(`[trending] found ${data.items.length} repos`);
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
        content: `Here is the README for the GitHub repository "${fullName}":\n\n${truncated}\n\nYou're texting a developer friend about a trending GitHub repo. In ONE sentence, max 25 words, tell them what it is and whether it's actually interesting. Be blunt and casual — the way you'd text, not a product description. You're allowed to be dismissive if it's derivative ('another X, but nothing special') and hyped if it's genuinely cool. No marketing voice, no 'this project,' no hedging, no markdown. Just the take.`,
      },
    ],
  });
  const textBlock = message.content.find((block) => block.type === "text");
  return textBlock ? textBlock.text.trim() : null;
}

app.get("/api/trending", async (req, res) => {
  try {
    const repos = await fetchTrendingRepos();

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
            return { ...base, summary: null };
          }
          const summary = await summarizeReadme(repo.full_name, readme);
          console.log(`[trending] done: ${repo.full_name}`);
          return { ...base, summary };
        } catch (err) {
          console.log(`[trending] failed to summarize ${repo.full_name}: ${err.message}`);
          return { ...base, summary: null };
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
