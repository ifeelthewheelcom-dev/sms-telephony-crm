const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase configuration in .env");
  process.exit(1);
}

// Bypasses RLS to allow backend to insert Twilio webhooks and manage data globally across all users
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
