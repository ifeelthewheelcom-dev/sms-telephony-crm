require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').single();
  console.log("Admin ID:", admin?.id);
  
  if (admin) {
    const contactPhone = "+15551234567";
    const { data: newContact, error: insertErr } = await db.from('contacts').insert([{ 
      user_id: admin.id, 
      phone_number: contactPhone, 
      last_message: '[ Call ]', 
      updated_at: new Date().toISOString() 
    }]).select('id').single();
    
    console.log("Insert Contact result:", newContact, "Error:", insertErr);
    
    if (newContact) {
      await db.from('contacts').delete().eq('id', newContact.id);
    }
  }
}
test();
