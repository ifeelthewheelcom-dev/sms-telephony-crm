const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) console.error("Error:", error);
  else console.log(data);
}
run();
