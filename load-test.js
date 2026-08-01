// load-test.js
// Usage:
//   SUPABASE_URL=https://yourproject.supabase.co \
//   SUPABASE_ANON_KEY=your-anon-key \
//   node load-test.js --concurrency=20 --requests=200
//
// What this actually tests: repeated concurrent reads against your posts
// table via the same anon-key REST path your real app uses (not raw
// Postgres, not your static frontend — Vercel's CDN already handles
// static files trivially, there's little to learn testing that). This is
// the part that can genuinely fall over under real traffic, so it's the
// part worth measuring.
//
// IMPORTANT — start small and prefer testing against staging if you have
// it set up. Concurrency of 20 is a reasonable starting point; don't jump
// straight to hundreds against production on your first run. Every
// request here is a real read against your real database.

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")),
);
const concurrency = parseInt(args.concurrency || "20", 10);
const totalRequests = parseInt(args.requests || "200", 10);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.",
  );
  process.exit(1);
}

async function fetchPostsPage() {
  const start = performance.now();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/posts?select=id,title,price&order=created_at.desc&limit=15`,
    {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    },
  );
  const durationMs = performance.now() - start;
  return { ok: res.ok, status: res.status, durationMs };
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return Math.round(sorted[idx]);
}

async function runBatch(size) {
  return Promise.all(Array.from({ length: size }, fetchPostsPage));
}

async function main() {
  console.log(
    `Load testing ${SUPABASE_URL} — ${totalRequests} requests at concurrency ${concurrency}\n`,
  );

  const results = [];
  let completed = 0;
  while (completed < totalRequests) {
    const batchSize = Math.min(concurrency, totalRequests - completed);
    const batch = await runBatch(batchSize);
    results.push(...batch);
    completed += batchSize;
    process.stdout.write(`\r  ${completed}/${totalRequests} completed`);
  }
  console.log("\n");

  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const errors = results.filter((r) => !r.ok);

  console.log("── Results ──────────────────────────");
  console.log(`Total requests:  ${results.length}`);
  console.log(
    `Errors:          ${errors.length} (${((errors.length / results.length) * 100).toFixed(1)}%)`,
  );
  console.log(`Min:             ${Math.round(durations[0])}ms`);
  console.log(`Median (p50):    ${percentile(durations, 0.5)}ms`);
  console.log(`p95:             ${percentile(durations, 0.95)}ms`);
  console.log(`p99:             ${percentile(durations, 0.99)}ms`);
  console.log(
    `Max:             ${Math.round(durations[durations.length - 1])}ms`,
  );

  if (errors.length > 0) {
    const statusCounts = {};
    errors.forEach((e) => {
      statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
    });
    console.log("\nError status codes:", statusCounts);
    console.log(
      "A 429 here means you hit a rate limit — that's Supabase protecting itself, worth knowing your actual ceiling.",
    );
  }

  console.log("\nWhat to do with these numbers:");
  console.log(
    "- p95 under ~300ms at this concurrency: comfortable headroom for now.",
  );
  console.log(
    "- p95 climbing sharply as concurrency increases: you're near your current plan's ceiling — consider Supabase's compute add-ons or checking Database -> Reports for CPU/memory pressure during the test.",
  );
  console.log(
    "- Any errors at all: investigate before assuming everything scales fine.",
  );
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
