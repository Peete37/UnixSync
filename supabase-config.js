// 1. Import the official Supabase CDN wrapper
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

// 2. Add your specific project credentials
const supabaseUrl = 'https://cdyurrvaprdpinabytvz.supabase.co'
const supabaseAnonKey = 'sb_publishable_4S2pNwY5rQyaMpcFdTeQVw_yYeU2PVF' 

// 3. Initialize the true Supabase client
export const supabase = createClient(supabaseUrl, supabaseAnonKey)