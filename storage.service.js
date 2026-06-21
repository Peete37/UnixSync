// ─── 1. CENTRALIZED CONFIG IMPORT ───────────────────────────────────────────
import { supabase } from "./supabase-config.js";

const MAX_IMAGE_SIZE_MB = 10;
const MAX_VIDEO_SIZE_MB = 100;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];

// Name of your bucket created inside your Supabase dashboard
const STORAGE_BUCKET_NAME = "posts"; 

/**
 * Validate file types and size bounds before consuming network bytes
 */
function validateFile(file) {
  const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
  const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);

  if (!isImage && !isVideo) {
    throw new Error(`Unsupported file type: ${file.type}`);
  }

  const maxMB = isVideo ? MAX_VIDEO_SIZE_MB : MAX_IMAGE_SIZE_MB;
  const sizeMB = file.size / (1024 * 1024);

  if (sizeMB > maxMB) {
    throw new Error(`File too large. Max ${maxMB}MB allowed.`);
  }

  return isVideo ? "video" : "image";
}

/**
 * Upload a single file to a Supabase Storage Bucket with a trackable progress hook
 * @param {File} file - Raw file blob object
 * @param {string} uid - Uploader's user authentication ID
 * @param {function} onProgress - Callout hook updating UI presentation percentages
 */
export async function uploadMedia(file, uid, onProgress) {
  try {
    const mediaType = validateFile(file);

    // Extract original extension safely and generate collision-proof names
    const ext = file.name.split(".").pop();
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    
    // Path format inside the bucket (e.g., "uid/filename.ext")
    const storagePath = `${uid}/${filename}`;

    // Upload using Supabase storage API with progress monitoring
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET_NAME)
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type,
        // Native Supabase hook to track progress percentages accurately
        onUploadProgress: (progressEvent) => {
          const progress = (progressEvent.loaded / progressEvent.total) * 100;
          onProgress?.(Math.round(progress));
        }
      });

    if (error) throw error;

    // Get the clean, permanent public access URL for your UI loop
    const { data: { publicUrl } } = supabase.storage
      .from(STORAGE_BUCKET_NAME)
      .getPublicUrl(storagePath);

    return { 
      url: publicUrl, 
      mediaType, 
      path: storagePath // Used if you ever need to call deleteMedia later
    };

  } catch (error) {
    console.error("Upload Execution Error:", error);
    throw new Error(`Upload failed: ${error.message || error}`);
  }
}

/**
 * Multi-file batch coordinator maps directly over array selections
 * Runs concurrently inside Promise.all blocks
 */
export async function uploadMultipleMedia(files, uid, onProgress) {
  if (!files || !files.length) return [];
  
  return Promise.all(
    files.map((file, i) =>
      uploadMedia(file, uid, (progress) => onProgress?.(i, progress))
    )
  );
}

/**
 * Delete a file from a Supabase Storage bucket path reference
 */
export async function deleteMedia(storagePath) {
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET_NAME)
    .remove([storagePath]); // Supabase .remove expects path arrays!

  if (error) {
    console.error("Error removing media file:", error);
    throw error;
  }
}

/**
 * Generate quick client-side localized previews
 */
export function createLocalPreview(file) {
  if (!file) return "";
  return URL.createObjectURL(file);
}