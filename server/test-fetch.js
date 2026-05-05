require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await db.from('messages').select('*').eq('type', 'call').order('created_at', { ascending: false }).limit(10);
  console.log("Last 10 call messages:");
  console.log(data);
}
run();
