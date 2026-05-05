require('dotenv').config();
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
// Trust Railway's reverse proxy so req.protocol returns 'https' correctly
app.set('trust proxy', 1);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(accountSid, authToken);

// Prefer an explicit BASE_URL env var (set this in Railway dashboard).
// Always force HTTPS — Railway terminates SSL at the load balancer so
// req.protocol would otherwise return 'http', which Twilio rejects for callbacks.
const getBaseUrl = (req) => {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `https://${host}`; // always HTTPS — Twilio requires it
};

const upload = multer({ dest: 'uploads/' });

// In-memory queue that reliably bridges call-ended ↔ recording-ready
// regardless of which webhook fires first.
// recordingQueue[callSid] = { messageId } | { recordingUrl }
const recordingQueue = new Map();

// -- MIDDLEWARE --
// Validates the JWT from the frontend and extracts the underlying user session.
const authMiddleware = async (req, res, next) => {
  if (req.path.startsWith('/webhooks')) return next();
  if (req.path.startsWith('/recordings')) return next(); // audio elements can't send auth headers
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
  const { data, error } = await db.from('contacts').select('*').eq('user_id', req.user.id).not('last_message', 'is', null).order('updated_at', { ascending: false });
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

app.get('/api/messages/poll-inbound', async (req, res) => {
  const { since } = req.query;
  if (!since) return res.json({ new_messages: false });
  
  // Notify for: new inbound SMS  OR  missed inbound calls (not completed)
  const { data: smsData } = await db.from('messages')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('direction', 'inbound')
      .eq('type', 'sms')
      .gt('created_at', since)
      .limit(1);

  const { data: missedCallData } = await db.from('messages')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('direction', 'inbound')
      .eq('type', 'call')
      .neq('status', 'completed')
      .gt('created_at', since)
      .limit(1);
      
  const hasNew = (smsData && smsData.length > 0) || (missedCallData && missedCallData.length > 0);
  res.json({ new_messages: hasNew });
});

app.post('/api/contacts/batch-delete', async (req, res) => {
  const { contact_ids } = req.body;
  if (!contact_ids || !Array.isArray(contact_ids) || contact_ids.length === 0) {
      return res.status(400).json({ error: 'Missing contact_ids' });
  }
  
  const { error } = await db.from('contacts')
      .delete()
      .in('id', contact_ids)
      .eq('user_id', req.user.id);
      
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/contacts/push-to-inbox', async (req, res) => {
  const { contact_ids } = req.body;
  if (!contact_ids || !Array.isArray(contact_ids) || contact_ids.length === 0) {
      return res.status(400).json({ error: 'Missing contact_ids' });
  }
  
  // Set last_message to a placeholder so it appears in the inbox list
  const { error } = await db.from('contacts')
      .update({ last_message: '[ Added to Inbox ]', updated_at: new Date().toISOString() })
      .in('id', contact_ids)
      .eq('user_id', req.user.id);
      
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/messages/send', async (req, res) => {
  let { to, content, override_from } = req.body;
  if (!to || !content) return res.status(400).json({ error: 'Missing to or content' });
  
  const originalTo = to;
  let cleanTo = to.replace(/[^\d+]/g, '');
  if (cleanTo && !cleanTo.startsWith('+')) {
    // 10-digit US number → add +1 country code
    cleanTo = cleanTo.length === 10 ? '+1' + cleanTo : '+' + cleanTo;
  }

  // Search by either format, fetching the most recently updated if multiple exist
  const { data: matchRows } = await db.from('contacts')
      .select('*')
      .in('phone_number', [originalTo, cleanTo, to])
      .eq('user_id', req.user.id)
      .order('updated_at', { ascending: false })
      .limit(1);
      
  const row = (matchRows && matchRows.length > 0) ? matchRows[0] : null;
  to = cleanTo; // Use clean version for Twilio
  
  let fromNumber = twilioNumber;
  const { data: pools } = await db.from('user_phone_numbers').select('phone_number').eq('user_id', req.user.id);
  if (pools && pools.length > 0) fromNumber = pools[0].phone_number;
  
  if (override_from) {
    fromNumber = override_from;
    if (row) await db.from('contacts').update({ assigned_sender_number: fromNumber, updated_at: new Date().toISOString() }).eq('id', row.id);
  } else if (row && row.assigned_sender_number) {
    fromNumber = row.assigned_sender_number;
  }

  // Parse custom variables out dynamically prior to sending manual outbounds
  if (row && row.custom_variables) {
      try {
          const vars = typeof row.custom_variables === 'string' ? JSON.parse(row.custom_variables) : row.custom_variables;
          content = content.replace(/\{\{\s*([a-zA-Z0-9_\s-]+)\s*\}\}/g, (match, p1) => {
              return vars[p1] !== undefined ? vars[p1] : match;
          });
      } catch(e) {}
  }

  try {
    const message = await twilioClient.messages.create({ body: content, from: fromNumber, to });
    
    let contactId = row ? row.id : null;
    if (!contactId) {
        const { data: newContact, error } = await db.from('contacts').insert({
            user_id: req.user.id,
            phone_number: to,
            last_message: content,
            assigned_sender_number: fromNumber,
            updated_at: new Date().toISOString()
        }).select('id').single();
        if (error) throw error;
        contactId = newContact?.id;
    } else {
        await db.from('contacts').update({ last_message: content, assigned_sender_number: fromNumber, updated_at: new Date().toISOString() }).eq('id', contactId);
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

    res.json({ success: true, sid: message.sid, contactId: contactId });
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

// ==============================================================
// VOICEMAIL ENDPOINTS
// ==============================================================
const audioUpload = multer({ storage: multer.memoryStorage() });

app.post('/api/voicemail/upload', audioUpload.single('audio'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No audio file received' });
        const filename = `voicemails/${req.user.id}/${Date.now()}.webm`;
        const { error: uploadError } = await db.storage
            .from('voicemails')
            .upload(filename, req.file.buffer, { contentType: req.file.mimetype || 'audio/webm', upsert: false });
        if (uploadError) return res.status(500).json({ error: uploadError.message });
        const { data: urlData } = db.storage.from('voicemails').getPublicUrl(filename);
        res.json({ url: urlData.publicUrl, path: filename });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/voicemail/list', async (req, res) => {
    const { data, error } = await db.storage.from('voicemails').list(`voicemails/${req.user.id}`, { sortBy: { column: 'created_at', order: 'desc' } });
    if (error) return res.json([]);
    const files = (data || []).map(f => {
        const path = `voicemails/${req.user.id}/${f.name}`;
        const { data: u } = db.storage.from('voicemails').getPublicUrl(path);
        return { name: f.name, url: u.publicUrl, path, created_at: f.created_at };
    });
    res.json(files);
});

app.delete('/api/voicemail/file', async (req, res) => {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'Missing path' });
    await db.storage.from('voicemails').remove([path]);
    res.json({ success: true });
});

app.post('/api/voicemail/drop', async (req, res) => {
    let { to, voicemail_url, from_number } = req.body;
    if (!to || !voicemail_url) return res.status(400).json({ error: 'Missing to or voicemail_url' });
    let cleanTo = to.replace(/[^\d+]/g, '');
    if (cleanTo && !cleanTo.startsWith('+')) cleanTo = cleanTo.length === 10 ? '+1' + cleanTo : '+' + cleanTo;
    const { data: pools } = await db.from('user_phone_numbers').select('phone_number').eq('user_id', req.user.id);
    const fromNumber = from_number || (pools && pools.length > 0 ? pools[0].phone_number : twilioNumber);
    const host = `${req.protocol}://${req.get('host')}`;
    const encodedUrl = encodeURIComponent(voicemail_url);
    const twimlUrl = `${host}/webhooks/voicemail-play?vm=${encodedUrl}`;
    try {
        const call = await twilioClient.calls.create({
            to: cleanTo, from: fromNumber,
            url: twimlUrl,
            machineDetection: 'DetectMessageEnd',
            asyncAmd: 'true',
            asyncAmdStatusCallback: twimlUrl,
        });
        res.json({ success: true, callSid: call.sid });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/webhooks/voicemail-play', express.urlencoded({ extended: true }), (req, res) => {
    const vmUrl = req.query.vm;
    const answeredBy = req.body.AnsweredBy;
    console.log(`📞 AMD: ${answeredBy} | VM: ${vmUrl}`);
    const twiml = new twilio.twiml.VoiceResponse();
    if (!answeredBy || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other' || answeredBy === 'unknown') {
        if (vmUrl) twiml.play(decodeURIComponent(vmUrl));
        else twiml.say({ voice: 'alice' }, 'Please call back at your earliest convenience.');
    }
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
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

app.delete('/api/lists/:id', async (req, res) => {
    // Cascade-clean mappings and linked sequence campaigns smoothly
    await db.from('campaigns').delete().eq('list_id', req.params.id);
    await db.from('lead_lists_mapping').delete().eq('list_id', req.params.id);
    const { error } = await db.from('lead_lists').delete().eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.get('/api/lists/:id/contacts', async (req, res) => {
   const { data, error } = await db.from('lead_lists_mapping').select('contacts(*)').eq('list_id', req.params.id);
   if (error) return res.status(500).json({ error: error.message });
   res.json((data || []).map(d => d.contacts).filter(Boolean));
});

app.get('/api/lists/:id/columns', async (req, res) => {
    const { data, error } = await db.from('lead_lists_mapping')
           .select('contacts(custom_variables)')
           .eq('list_id', req.params.id)
           .not('contacts.custom_variables', 'is', null)
           .limit(1)
           .single();
           
    if (error || !data || !data.contacts || !data.contacts.custom_variables) return res.json([]);
    try {
        const vars = typeof data.contacts.custom_variables === 'string' ? JSON.parse(data.contacts.custom_variables) : data.contacts.custom_variables;
        res.json(Object.keys(vars));
    } catch(e) { res.json([]); }
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
  // Twilio encodes '+' as a space in form-posted params — restore it
  let targetNumber = (req.body.TargetNumber || '').replace(/\s/g, '+').trim();
  const callerId = process.env.TWILIO_PHONE_NUMBER;
  const base = getBaseUrl(req);
  console.log(`📤 outbound-call | target=${targetNumber} | base=${base}`);

  const twiml = new twilio.twiml.VoiceResponse();
  if (targetNumber) {
    // Resolve which user owns the caller ID so we can pass userId in the action URL
    let ownerUserId = '';
    const { data: ownerMatch } = await db.from('user_phone_numbers').select('user_id').eq('phone_number', callerId).single();
    if (ownerMatch?.user_id) {
      ownerUserId = ownerMatch.user_id;
    } else {
      const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').single();
      if (admin?.id) ownerUserId = admin.id;
    }

    const dial = twiml.dial({
      callerId,
      answerOnBridge: true,
      record: 'record-from-answer',
      recordingStatusCallback: `${base}/api/webhooks/recording-ready`,
      recordingStatusCallbackMethod: 'POST',
      action: `${base}/api/webhooks/call-ended?direction=outbound&target=${encodeURIComponent(targetNumber)}&userId=${encodeURIComponent(ownerUserId)}`
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
      const base = getBaseUrl(req);
      const dial = twiml.dial({ 
        timeout: 30, 
        answerOnBridge: true,
        record: 'record-from-answer',
        recordingStatusCallback: `${base}/api/webhooks/recording-ready`,
        recordingStatusCallbackMethod: 'POST',
        action: `${base}/api/webhooks/call-ended?direction=inbound&target=${encodeURIComponent(cleanTo)}&userId=${encodeURIComponent(phoneMatch?.user_id || '')}`
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
  const { DialCallStatus, DialCallDuration, From, RecordingUrl, CallSid } = req.body;
  const cleanFrom = (From || '').replace(/[^\d+]/g, '');
  let phoneStr = cleanFrom;
  if (phoneStr && !phoneStr.startsWith('+')) phoneStr = '+' + phoneStr;

  // userId is now explicitly passed in the action URL for both directions
  let actualUserId = userId || '';
  // For outbound: target is the dialed number (already URL-decoded by Express)
  // For inbound:  From is the caller's number
  let contactPhone = direction === 'outbound' ? (target || '') : phoneStr;

  // Last resort: admin fallback
  if (!actualUserId) {
    const { data: admin } = await db.from('profiles').select('id').eq('role', 'admin').single();
    if (admin) actualUserId = admin.id;
  }

  console.log(`📋 call-ended | dir=${direction} status=${DialCallStatus} contact=${contactPhone} user=${actualUserId} callSid=${CallSid}`);

  if (actualUserId && contactPhone) {
    let contact_id = null;
    const { data: existingContact } = await db.from('contacts').select('id').eq('phone_number', contactPhone).eq('user_id', actualUserId).single();
    if (existingContact) {
      contact_id = existingContact.id;
    } else {
      const { data: newContact } = await db.from('contacts').insert([{ user_id: actualUserId, phone_number: contactPhone, last_message: '[ Call ]', updated_at: new Date().toISOString() }]).select('id').single();
      if (newContact) contact_id = newContact.id;
    }

    if (contact_id) {
      const isCompleted = DialCallStatus === 'completed';
      const msgContent = isCompleted
        ? `📞 ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call (${DialCallDuration || 0}s)`
        : `❌ Missed ${direction === 'outbound' ? 'Outbound' : 'Inbound'} Call`;

      // Use RecordingUrl from action body if Twilio already has it (short calls)
      const immediateRecUrl = (isCompleted && RecordingUrl) ? `${RecordingUrl}.mp3` : null;

      const { data: savedMsg } = await db.from('messages').insert([{
        user_id: actualUserId,
        contact_id,
        direction,
        type: 'call',
        content: msgContent,
        status: DialCallStatus || 'failed',
        recording_url: immediateRecUrl
      }]).select('id').single();

      // Wire up in-memory queue so recording-ready can find this message by CallSid
      if (isCompleted && CallSid && !immediateRecUrl && savedMsg?.id) {
        const queued = recordingQueue.get(CallSid);
        if (queued?.recordingUrl) {
          // recording-ready already fired — apply now
          await db.from('messages').update({ recording_url: queued.recordingUrl }).eq('id', savedMsg.id);
          recordingQueue.delete(CallSid);
          console.log(`✅ Recording applied immediately from queue for ${CallSid}`);
        } else {
          recordingQueue.set(CallSid, { messageId: savedMsg.id });
          setTimeout(() => recordingQueue.delete(CallSid), 600000);
        }
      }

      // Update contact last_message
      await db.from('contacts').update({ last_message: msgContent, updated_at: new Date().toISOString() }).eq('id', contact_id);
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  res.type('text/xml').send(twiml.toString());
});


// Called by Twilio when a recording is fully processed and ready.
// Uses the in-memory recordingQueue to find the right message by CallSid.
app.post('/api/webhooks/recording-ready', async (req, res) => {
  const { CallSid, ParentCallSid, RecordingUrl, RecordingStatus } = req.body;
  console.log(`🎙️ Recording ready: ${RecordingStatus} | CallSid: ${CallSid} | Parent: ${ParentCallSid} | URL: ${RecordingUrl}`);

  if (RecordingStatus === 'completed' && RecordingUrl) {
    const mp3Url = `${RecordingUrl}.mp3`;
    const sid = CallSid || ParentCallSid;

    const queued = recordingQueue.get(sid) || recordingQueue.get(ParentCallSid) || recordingQueue.get(CallSid);
    if (queued?.messageId) {
      // call-ended already fired — update message directly by ID
      await db.from('messages').update({ recording_url: mp3Url }).eq('id', queued.messageId);
      recordingQueue.delete(sid);
      recordingQueue.delete(ParentCallSid);
      console.log(`✅ Recording attached to message ${queued.messageId}`);
    } else {
      // call-ended hasn't fired yet — store URL so call-ended can apply it
      recordingQueue.set(sid, { recordingUrl: mp3Url });
      if (ParentCallSid) recordingQueue.set(ParentCallSid, { recordingUrl: mp3Url });
      setTimeout(() => { recordingQueue.delete(sid); recordingQueue.delete(ParentCallSid); }, 600000);
      console.log(`⏳ Recording queued for CallSid ${sid} — awaiting call-ended`);
    }
  }

  res.sendStatus(204);
});

// Secure proxy: streams Twilio recording audio through the server so the browser
// doesn't need Twilio credentials directly
app.get('/api/recordings', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!response.ok) return res.status(response.status).send('Recording not available');
    res.set('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);
  } catch(err) {
    console.error('Recording proxy error:', err);
    res.status(500).send('Error fetching recording');
  }
});

// -- TWILIO WEBHOOKS SMS (Public) --
app.post('/api/webhooks/incoming-sms', async (req, res) => {
  const { From, To, Body } = req.body;
  // Sanitize both numbers — Twilio sometimes sends them with formatting variations
  let cleanFrom = (From || '').replace(/[^\d+]/g, '');
  let cleanTo   = (To   || '').replace(/[^\d+]/g, '');
  if (cleanFrom && !cleanFrom.startsWith('+')) cleanFrom = cleanFrom.length === 10 ? '+1' + cleanFrom : '+' + cleanFrom;
  if (cleanTo   && !cleanTo.startsWith('+'))   cleanTo   = cleanTo.length   === 10 ? '+1' + cleanTo   : '+' + cleanTo;

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
      // Robust lookup allowing for E.164 Twilio incoming matches against loose CRM imported formats
      let searchVariants = [From, cleanFrom];
      if (cleanFrom.startsWith('+1') && cleanFrom.length === 12) {
          const last10 = cleanFrom.substring(2);
          searchVariants.push(last10);
          searchVariants.push(`1${last10}`);
          searchVariants.push(`(${last10.substring(0,3)}) ${last10.substring(3,6)}-${last10.substring(6)}`);
          searchVariants.push(`${last10.substring(0,3)}-${last10.substring(3,6)}-${last10.substring(6)}`);
      }

      const { data: matchRows } = await db.from('contacts')
          .select('id')
          .in('phone_number', searchVariants)
          .eq('user_id', user_id)
          .order('updated_at', { ascending: false })
          .limit(1);
          
      let contact_id = (matchRows && matchRows.length > 0) ? matchRows[0].id : null;
      
      if (!contact_id) {
          const { data: newContact, error } = await db.from('contacts').insert({
              user_id, phone_number: cleanFrom, last_message: Body, assigned_sender_number: cleanTo, updated_at: new Date().toISOString()
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
  app.get('/*path', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

app.listen(port, '0.0.0.0', () => console.log(`🚀 Supabase Backend running on http://0.0.0.0:${port}`));
