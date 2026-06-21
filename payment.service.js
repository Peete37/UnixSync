// ─── 1. CENTRALIZED CONFIG IMPORT ───────────────────────────────────────────
import { supabase } from "./supabase-config.js";

/**
 * Simulate a successful GH₵5 influencer payment.
 * Real Paystack/Hubtel verification must be done server-side.
 */
export async function simulateInfluencerPayment(uid) {
  // Fake network/payment delay
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 7 days from now
  const expiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Update the columns directly inside your custom 'users' table
    const { error } = await supabase
      .from("users")
      .update({
        isInfluencer: true,
        expiryDate: expiryDate, // Stored as a clean timestamp with timezone string
      })
      .eq("id", uid);

    if (error) throw error;

    return {
      success: true,
      amount: 5,
      currency: "GHS",
      expiryDate,
      message: "Top Influencer activated for 7 days.",
    };
  } catch (error) {
    console.error("Influencer activation error:", error.message || error);
    return {
      success: false,
      message: `Activation failed: ${error.message}`,
    };
  }
}
