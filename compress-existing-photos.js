/**
 * One-time cleanup: recompress listing photos that are ALREADY sitting in
 * Supabase Storage from before the upload-time compression fix.
 *
 * What it does:
 *   1. Walks every file in the "posts" bucket (recursively — files live
 *      under <userId>/<timestamp>-<i>.<ext>, so it lists each user folder
 *      too, not just the top level).
 *   2. Skips videos and anything already reasonably small (< SKIP_UNDER_KB).
 *   3. Downloads each remaining image, resizes to the SAME limits the app
 *      now uses on new uploads (max 1600px on the longest side, JPEG
 *      quality 0.8 — PNGs are converted to JPEG too, matching what
 *      compressImageFile() does client-side, since these are photos, not
 *      graphics that need transparency).
 *   4. Re-uploads only if the result is meaningfully smaller (>= 15%
 *      savings) — otherwise leaves the original alone.
 *   5. Runs in DRY-RUN mode by default (prints what it WOULD do, changes
 *      nothing). Pass --run to actually upload the compressed versions.
 *
 * Setup:
 *   npm install @supabase/supabase-js sharp
 *
 * Usage:
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
 *   node compress-existing-photos.js            # dry run — safe, no changes
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
 *   node compress-existing-photos.js --run       # actually re-upload
 *
 * IMPORTANT: use the SERVICE ROLE key (Project Settings → API), not the
 * public anon key — this needs to read/write every user's files, not just
 * one signed-in user's own folder. Never put the service role key in the
 * app itself; it's only for running this script from your own machine.
 */

const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "posts";
const MAX_DIMENSION = 1600; // matches maxDimension in compressImageFile() for posts
const JPEG_QUALITY = 80; // matches quality: 0.8
const SKIP_UNDER_KB = 300; // not worth re-processing tiny files
const MIN_SAVINGS = 0.15; // only replace if we save at least 15%

const DRY_RUN = !process.argv.includes("--run");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

function fmtKB(bytes) {
  return (bytes / 1024).toFixed(0) + "KB";
}

// Recursively list every file under the bucket. Supabase's list() only
// returns one folder level at a time, and this bucket is organized as
// <userId>/<file>, so we list the root to get user folders, then list
// inside each one.
async function listAllFiles() {
  const files = [];
  const { data: topLevel, error: topErr } = await supabase.storage
    .from(BUCKET)
    .list("", { limit: 1000 });
  if (topErr) throw topErr;

  for (const entry of topLevel) {
    // Folders come back with id === null; files have a real id.
    if (entry.id === null) {
      const { data: inner, error: innerErr } = await supabase.storage
        .from(BUCKET)
        .list(entry.name, { limit: 1000 });
      if (innerErr) {
        console.warn(
          `  Could not list folder ${entry.name}:`,
          innerErr.message,
        );
        continue;
      }
      for (const f of inner) {
        if (f.id !== null) files.push(`${entry.name}/${f.name}`);
      }
    } else {
      files.push(entry.name);
    }
  }
  return files;
}

async function run() {
  console.log(
    DRY_RUN
      ? "DRY RUN — no files will be changed. Pass --run to actually upload.\n"
      : "LIVE RUN — compressed files will replace originals.\n",
  );

  console.log("Listing files in bucket…");
  const paths = await listAllFiles();
  console.log(`Found ${paths.length} files.\n`);

  let processed = 0,
    skippedVideo = 0,
    skippedSmall = 0,
    skippedNoSavings = 0,
    compressed = 0,
    failed = 0;
  let totalBefore = 0,
    totalAfter = 0;

  for (const path of paths) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    if (!IMAGE_EXT.has(ext)) {
      skippedVideo++;
      continue;
    }

    try {
      const { data: blob, error: dlErr } = await supabase.storage
        .from(BUCKET)
        .download(path);
      if (dlErr) throw dlErr;

      const original = Buffer.from(await blob.arrayBuffer());
      if (original.length < SKIP_UNDER_KB * 1024) {
        skippedSmall++;
        continue;
      }

      const compressedBuf = await sharp(original)
        .resize({
          width: MAX_DIMENSION,
          height: MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      const savings = 1 - compressedBuf.length / original.length;
      processed++;

      if (savings < MIN_SAVINGS) {
        skippedNoSavings++;
        continue;
      }

      totalBefore += original.length;
      totalAfter += compressedBuf.length;
      compressed++;

      console.log(
        `${DRY_RUN ? "[would compress]" : "[compressing]  "} ${path}  ${fmtKB(original.length)} -> ${fmtKB(compressedBuf.length)}  (-${(savings * 100).toFixed(0)}%)`,
      );

      if (!DRY_RUN) {
        const { error: upErr } = await supabase.storage
          .from(BUCKET)
          .upload(path, compressedBuf, {
            contentType: "image/jpeg",
            upsert: true,
          });
        if (upErr) throw upErr;
      }
    } catch (err) {
      failed++;
      console.warn(`  FAILED on ${path}:`, err.message || err);
    }
  }

  console.log("\n── Summary ──────────────────────────");
  console.log(`Images checked:        ${processed}`);
  console.log(`Compressed:             ${compressed}`);
  console.log(`Skipped (non-image):    ${skippedVideo}`);
  console.log(`Skipped (already small):${skippedSmall}`);
  console.log(`Skipped (not worth it): ${skippedNoSavings}`);
  console.log(`Failed:                 ${failed}`);
  if (compressed > 0) {
    console.log(
      `Total size:  ${fmtKB(totalBefore)} -> ${fmtKB(totalAfter)}  (saved ${fmtKB(totalBefore - totalAfter)}, -${((1 - totalAfter / totalBefore) * 100).toFixed(0)}%)`,
    );
  }
  if (DRY_RUN) {
    console.log(
      "\nThis was a dry run — nothing was changed. Re-run with --run to apply.",
    );
  }
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
