const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function getAdmin() {
  const { data, error } = await supabase.auth.admin.listUsers();
  if (data && data.users) {
      console.log("USERS:", data.users.map(u => ({ email: u.email })));
  }
}
getAdmin();
