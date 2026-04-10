require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const multer = require('multer');
const fs = require('fs');
const csvParser = require('csv-parser');
const db = require('./db'); 

// const { startSequenceEngine } = require('./cron'); // Temporarily bypassing cron for Supabase translation

const app = express();
const port = process.env.PORT || 8142;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

const upload = multer({ dest: 'uploads/' });

// -- MIDDLEWARE --
// Validates the JWT from the frontend and extracts the underlying user session.
const authMiddleware = async (req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing auth header' });
  const token = authHeader.split(' ')[1];
  
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
  
  req.user = user;
  next();
};

app.use('/api', authMiddleware);

// -- INBOX ENDPOINTS --
app.get('/api/contacts', async (req, res) => {
  const { data, error } = await db.from('contacts').select('*').eq('user_id', req.user.id).order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get('/api/contacts/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { data, error } = await db.from('messages').select('*').eq('contact_id', id).eq('user_id', req.user.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.delete('/api/contacts/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await db.from('contacts').delete().eq('id', id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/messages/send', async (req, res) => {
  let { to, content, override_from } = req.body;
  if (!to || !content) return res.status(400).json({ error: 'Missing to or content' });
  // Normalize the destination number (user may type +1 (408) 123-4567)
  to = to.replace(/[^\d+]/g, '');
  
  const { data: row } = await db.from('contacts').select('*').eq('phone_number', to).eq('user_id', req.user.id).single();
  let fromNumber = twilioNumber;
  const { data: pools } = await db.from('user_phone_numbers').select('phone_number').eq('user_id', req.user.id);
  if (pools && pools.length > 0) fromNumber = pools[0].phone_number;
  
  if (override_from) {
    fromNumber = override_from;
    if (row) await db.from('contacts').update({ assigned_sender_number: fromNumber, updated_at: new Date().toISOString() }).eq('id', row.id);
  } else if (row && row.assigned_sender_number) {
    fromNumber = row.assigned_sender_number;
  }

  try {
    const message = await twilioClient.messages.create({ body: content, from: fromNumber, to });
    
    let contactId = row ? row.id : null;
    if (!contactId) {
        const { data: newContact, error } = await db.from('contacts').insert({
            user_id: req.user.id,
            phone_number: to,
            last_message: content,
            assigned_sender_number: fromNumber
        }).select('id').single();
        if (error) throw error;
        contactId = newContact?.id;
    } else {
        await db.from('contacts').update({ last_message: content, assigned_sender_number: fromNumber }).eq('id', contactId);
    }

    if (contactId) {
        await db.from('messages').insert({
            user_id: req.user.id,
            contact_id: contactId,
            direction: 'outbound',
            type: 'sms',
            content,
            status: message.status
        });
    }

    res.json({ success: true, sid: message.sid });
  } catch (error) {
    console.error('Twilio Send Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// -- ADMIN ENDPOINTS --
app.get('/api/me', async (req, res) => {
    const { data, error } = await db.from('profiles').select('role').eq('id', req.user.id).single();
    res.json(error ? { role: 'agent' } : data);
});

app.get('/api/admin/users', async (req, res) => {
    // Relies on RLS (only Admins can SELECT all profiles)
    const { data: profiles, error } = await db.from('profiles').select('id, email, role, created_at, user_phone_numbers(phone_number)');
    if (error) return res.status(500).json({ error: error.message });
    res.json(profiles);
});

app.post('/api/admin/assign-number', async (req, res) => {
    const { data: prof } = await db.from('profiles').select('role').eq('id', req.user.id).single();
    if (prof?.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });

    const { target_user_id, phone_number } = req.body;
    const cleanNumber = phone_number.replace(/[^\d+]/g, '');
    const { data, error } = await db.from('user_phone_numbers').insert({
        user_id: target_user_id,
        phone_number: cleanNumber
    });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.post('/api/admin/invite', async (req, res) => {
    const { data: prof } = await db.from('profiles').select('role').eq('id', req.user.id).single();
    if (prof?.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });

    const { email, password } = req.body;
    const { data: user, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, user });
});

// -- LIST ENDPOINTS --
app.get('/api/lists', async (req, res) => {
    const { data, error } = await db.from('lead_lists').select('id, name, created_at').eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    
    // Fallback simple count fetching (Supabase counts can be slightly tricky inside deeply joined selects without RPC)
    const enriched = [];
    for(const l of data || []){
        const { count } = await db.from('lead_lists_mapping').select('*', { count: 'exact', head: true }).eq('list_id', l.id);
        enriched.push({ ...l, lead_count: count || 0 });
    }
    res.json(enriched);
});

app.post('/api/lists/upload', upload.single('file'), async (req, res) => {
    const listName = req.body.name;
    const { data: newList, error: listErr } = await db.from('lead_lists').insert({ user_id: req.user.id, name: listName }).select('id').single();
    if (listErr) return res.status(500).json({ error: listErr.message });
    const listId = newList.id;

    const rows = [];
    fs.createReadStream(req.file.path).pipe(csvParser()).on('data', (data) => rows.push(data)).on('end', async () => {
        let count = 0;
        for (const row of rows) {
            let phone = row.phone || row.phone_number || row.Phone || row['Phone Number'];
            if (!phone) continue;
            const { data: contact } = await db.from('contacts').select('id').eq('phone_number', phone).eq('user_id', req.user.id).single();
            let contactId = contact?.id;
            if (!contactId) {
                const { data: newContact } = await db.from('contacts').insert({
                    user_id: req.user.id, phone_number: phone, custom_variables: JSON.stringify(row)
                }).select('id').single();
                contactId = newContact?.id;
            } else {
                await db.from('contacts').update({ custom_variables: JSON.stringify(row) }).eq('id', contactId);
            }
            if (contactId) {
                await db.from('lead_lists_mapping').insert({ list_id: listId, contact_id: contactId });
                count++;
            }
        }
        res.json({ success: true, count });
    });
});

// -- CAMPAIGN ENDPOINTS --
app.get('/api/senders', async (req, res) => {
   const { data } = await db.from('user_phone_numbers').select('*').eq('user_id', req.user.id);
   const basePool = data || [];
   if (!basePool.find(x => x.phone_number === process.env.TWILIO_PHONE_NUMBER)) {
       basePool.push({ phone_number: process.env.TWILIO_PHONE_NUMBER, friendly_name: 'Default Line' });
   }
   res.json(basePool.map(s => ({ id: s.id, phone_number: s.phone_number, name: s.friendly_name || 'Assigned Agent Line' })));
});

app.get('/api/campaigns', async (req, res) => {
   const { data, error } = await db.from('campaigns').select('*, lead_lists(name)').eq('user_id', req.user.id);
   res.json(data ? data.map(c => ({...c, list_name: c.lead_lists?.name, sender_pool: c.sender_pool || []})) : []);
});

app.post('/api/campaigns', async (req, res) => {
   const { name, list_id, sender_pool, steps, drip_rate } = req.body;
   
   const { data: camp, error } = await db.from('campaigns').insert({
       user_id: req.user.id, name, list_id, sender_pool: sender_pool, drip_rate
   }).select('id').single();

   if (error) return res.status(500).json({ error: error.message });

   for (const s of steps) {
       await db.from('campaign_steps').insert({ campaign_id: camp.id, step_order: s.order, delay_minutes: s.delay, content: s.content });
   }

   const { data: mappings } = await db.from('lead_lists_mapping').select('contact_id').eq('list_id', list_id);
   if (mappings) {
       for (const m of mappings) {
           await db.from('campaign_leads_status').insert({
               campaign_id: camp.id, contact_id: m.contact_id, current_step_order: 1, status: 'active',
               next_execution_time: new Date().toISOString()
           });
       }
   }
   res.json({ success: true });
});

// -- VOICE --
app.get('/api/voice/token', (req, res) => {
  const twilioApiKey = process.env.TWILIO_API_KEY;
  const twilioApiSecret = process.env.TWILIO_API_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  if (!twilioApiKey) return res.status(500).json({ error: 'Missing API Key logic' });
  const VoiceGrant = twilio.jwt.AccessToken.VoiceGrant;
  const voiceGrant = new VoiceGrant({ outgoingApplicationSid: twimlAppSid, incomingAllow: true });
  // Dynamic Identity mapped to User!
  const identity = `desktop_app_${req.user.id}`;
  const token = new twilio.jwt.AccessToken(accountSid, twilioApiKey, twilioApiSecret, { identity });
  token.addGrant(voiceGrant);
  res.json({ token: token.toJwt(), identity });
});

// -- TWILIO WEBHOOKS (Public) --
// Called by Twilio when the Twilio.Device.connect() fires from the browser
app.post('/api/webhooks/outbound-call', async (req, res) => {
  let targetNumber = req.body.TargetNumber;
  if (targetNumber) targetNumber = targetNumber.replace(' ', '+');
  const callerId = process.env.TWILIO_PHONE_NUMBER;
  const twiml = new twilio.twiml.VoiceResponse();
  if (targetNumber) {
    const dial = twiml.dial({ 
      callerId, 
      answerOnBridge: true,
      action: `https://${req.get('host')}/api/webhooks/call-ended?direction=outbound&target=${encodeURIComponent(targetNumber)}`
    });
    dial.number(targetNumber);
  } else {
    twiml.say('No target number provided.');
  }
  res.type('text/xml').send(twiml.toString());
});

// Called by Twilio when an inbound VOICE call comes in to one of your numbers
app.post('/api/webhooks/incoming-call', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  try {
    const { To } = req.body;
    let cleanTo = (To || '').replace(/[^\d+]/g, '');
    if (cleanTo && !cleanTo.startsWith('+')) cleanTo = '+' + cleanTo;
    console.log(`📞 Inbound voice call to: ${cleanTo}`);

    // Look up which agent owns the Twilio number that was called
    let clientIdentity = null;
    const { data: phoneMatch } = await db.from('user_phone_numbers').select('user_id').eq('phone_number', cleanTo).single();
    if (phoneMatch?.user_id) {
      clientIdentity = `desktop_app_${phoneMatch.user_id}`;
      console.log(`✅ Routing call to: ${clientIdentity}`);
    } else {
      // Fallback: ring the admin
      const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').single();
      if (admin?.id) clientIdentity = `desktop_app_${admin.id}`;
      console.log(`⚠️ No owner found — routing call to admin: ${clientIdentity}`);
    }

    if (clientIdentity) {
      const dial = twiml.dial({ 
        timeout: 30, 
        answerOnBridge: true,
        action: `https://${req.get('host')}/api/webhooks/call-ended?direction=inbound&target=${encodeURIComponent(cleanTo)}&userId=${encodeURIComponent(phoneMatch?.user_id || '')}`
      });
      dial.client(clientIdentity);
    } else {
      twiml.say('Sorry, no agent is available right now.');
    }
  } catch(err) {
    console.error('Incoming call webhook error:', err);
    twiml.say('Sorry, an error occurred routing your call.');
  }
  res.type('text/xml').send(twiml.toString());
});

// Logs the call to the conversation board once it's finished or missed
app.post('/api/webhooks/call-ended', async (req, res) => {
  const { direction, target, userId } = req.query;
  const { DialCallStatus, DialCallDuration, From } = req.body;
  const cleanFrom = (From || '').replace(/[^\d+]/g, '');
  let phoneStr = cleanFrom;
  if (phoneStr && !phoneStr.startsWith('+')) phoneStr = '+' + phoneStr;

  let actualUserId = userId;
  let contactPhone = direction === 'outbound' ? target : phoneStr;
  
  if (direction === 'outbound') {
     // User initiated from browser
     const callerId = process.env.TWILIO_PHONE_NUMBER;
     const { data: phoneMatch } = await db.from('user_phone_numbers').select('user_id').eq('phone_number', callerId).single();
     if (phoneMatch) actualUserId = phoneMatch.user_id;
  }
  
  if (!actualUserId) {
    const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').single();
    if (admin) actualUserId = admin.id;
  }

  if (actualUserId) {
    // Upsert contact
    let contact_id = null;
    const { data: existingContact } = await db.from('contacts').select('id').eq('phone_number', contactPhone).eq('user_id', actualUserId).single();
    if (existingContact) {
      contact_id = existingContact.id;
    } else {
      const { data: newContact } = await db.from('contacts').insert([{ user_id: actualUserId, phone_number: contactPhone, name: 'Unknown' }]).select('id').single();
      if (newContact) contact_id = newContact.id;
    }

    if (contact_id) {
       let msgContent = DialCallStatus === 'completed' 
          ? `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call (${DialCallDuration || 0}s)`
          : `❌ Missed Call (${direction === 'outbound' ? 'No Answer' : 'Missed'})`;
          
       await db.from('messages').insert([{
         user_id: actualUserId,
         contact_id,
         direction,
         type: 'call',
         content: msgContent,
         status: DialCallStatus || 'failed'
       }]);
    }
  }

  // Twilio needs an empty TwiML response to close the action hook gracefully
  const twiml = new twilio.twiml.VoiceResponse();
  res.type('text/xml').send(twiml.toString());
});

// -- TWILIO WEBHOOKS SMS (Public) --
app.post('/api/webhooks/incoming-sms', async (req, res) => {
  const { From, To, Body } = req.body;
  // Sanitize both numbers — Twilio sometimes sends them with formatting variations
  let cleanFrom = (From || '').replace(/[^\d+]/g, '');
  let cleanTo   = (To   || '').replace(/[^\d+]/g, '');
  if (cleanFrom && !cleanFrom.startsWith('+')) cleanFrom = '+' + cleanFrom;
  if (cleanTo && !cleanTo.startsWith('+')) cleanTo = '+' + cleanTo;

  console.log(`\n📨 INCOMING SMS | From: ${cleanFrom} → To: ${cleanTo} | Body: "${Body}"`);

  // PRIORITY 1: Route to the exact agent who owns the "To" number
  let user_id = null;
  const { data: phoneMatch } = await db.from('user_phone_numbers').select('user_id').eq('phone_number', cleanTo).single();
  if (phoneMatch?.user_id) {
      user_id = phoneMatch.user_id;
      console.log(`✅ Routed via user_phone_numbers → user_id: ${user_id}`);
  }

  // PRIORITY 2: Fallback — route to whoever last texted this person (respecting assigned_sender_number)
  if (!user_id) {
      const { data: stickyContact } = await db.from('contacts')
          .select('user_id')
          .eq('phone_number', cleanFrom)
          .eq('assigned_sender_number', cleanTo)
          .single();
      if (stickyContact?.user_id) {
          user_id = stickyContact.user_id;
          console.log(`✅ Routed via sticky contact match → user_id: ${user_id}`);
      }
  }

  // PRIORITY 3: Last resort — any contact that has texted this person
  if (!user_id) {
      const { data: previousContact } = await db.from('contacts')
          .select('user_id')
          .eq('phone_number', cleanFrom)
          .order('updated_at', { ascending: false })
          .limit(1)
          .single();
      if (previousContact?.user_id) {
          user_id = previousContact.user_id;
          console.log(`⚠️  Routed via contact history fallback → user_id: ${user_id}`);
      }
  }

  // PRIORITY 4: Absolute last resort — admin account
  if (!user_id) {
      const { data: fallbackUser } = await db.from('profiles').select('id').eq('role', 'admin').single();
      user_id = fallbackUser?.id;
      console.log(`🆘 Routed via admin fallback → user_id: ${user_id}`);
  }

  if (user_id) {
      const { data: contact } = await db.from('contacts').select('id').eq('phone_number', cleanFrom).eq('user_id', user_id).single();
      let contact_id = contact?.id;
      if (!contact_id) {
          const { data: newContact, error } = await db.from('contacts').insert({
              user_id, phone_number: cleanFrom, last_message: Body, assigned_sender_number: cleanTo
          }).select('id').single();
          if (!error) contact_id = newContact?.id;
      } else {
          await db.from('contacts').update({ last_message: Body, updated_at: new Date().toISOString() }).eq('id', contact_id);
      }

      if (contact_id) {
          await db.from('messages').insert({
              user_id, contact_id, direction: 'inbound', type: 'sms', content: Body, status: 'received'
          });
          console.log(`💾 Message saved. contact_id: ${contact_id}`);
      }
  } else {
      console.log(`❌ CRITICAL: Could not route message. Dropped!`);
  }

  res.type('text/xml').send(new twilio.twiml.MessagingResponse().toString());
});

if (process.env.NODE_ENV === 'production') {
  const path = require('path');
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

app.listen(port, () => console.log(`🚀 Supabase Backend running on http://localhost:${port}`));
