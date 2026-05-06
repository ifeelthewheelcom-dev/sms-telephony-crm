import React, { useState, useEffect, useRef } from 'react';
import { Phone, Send, User, MessageCircle, Mic, PhoneOff, PhoneCall, Zap, Users, Component, Plus, UploadCloud, CheckCircle, AlertTriangle, Trash2, LogOut, ArrowLeft, Sparkles } from 'lucide-react';
import { Device } from '@twilio/voice-sdk';
import { supabase } from './supabaseClient';
import Login from './Login';

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:8142/api');

const authFetch = async (url, options = {}) => {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = { ...options.headers };
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  return fetch(url, { ...options, headers });
};

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error('Tab crashed:', error, info); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center bg-[#111b21]">
          <div className="text-center p-10 bg-[#202c33] rounded-2xl border border-rose-500/30 max-w-md">
            <p className="text-rose-400 font-bold text-lg mb-2">Something went wrong</p>
            <p className="text-neutral-400 text-sm mb-6">{this.state.error?.message || 'An unexpected error occurred'}</p>
            <button onClick={() => this.setState({ hasError: false, error: null })} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg text-sm font-bold transition">Try Again</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- MAIN WRAPPER ---
export default function App() {
  const [session, setSession] = useState(null);
  const [authInitialized, setAuthInitialized] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthInitialized(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (!authInitialized) {
    return <div className="h-screen bg-dark flex items-center justify-center text-white">Loading App...</div>;
  }

  if (!session) {
    return <Login />;
  }

  return <WorkspaceApp session={session} accessToken={session.access_token} />;
}

function WorkspaceApp({ session, accessToken }) {
  const [activeTab, setActiveTab] = useState('inbox');
  const [role, setRole] = useState('agent');
  const [senders, setSenders] = useState([]);
  
  const [inboxSelectedContact, setInboxSelectedContact] = useState(null);

  // Telephony State
  const deviceRef = useRef(null);
  const [callStatus, setCallStatus] = useState('initializing'); 
  const [activeCall, setActiveCall] = useState(null);

  const initializeDevice = async () => {
    try {
      // Destroy old device if exists
      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }
      setCallStatus('initializing');

      // Use the session token we already have — avoids race condition on mount
      const token = accessToken || (await supabase.auth.getSession()).data?.session?.access_token;
      if (!token) { console.error('No auth token available for voice init'); setCallStatus('error'); return; }

      const r = await fetch(`${API_BASE}/voice/token`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!data?.token) { console.error('No Twilio token returned:', data); setCallStatus('error'); return; }

      const newDevice = new Device(data.token, {
        codecPreferences: ['opus', 'pcmu'],
        fakeLocalDTMF: true,
        enableRingingState: true,
        logLevel: 1, // warn-level logging
      });

      newDevice.on('registered', () => {
        console.log('✅ Twilio Device registered — ready for calls');
        setCallStatus('ready');
      });
      newDevice.on('unregistered', () => {
        console.warn('⚠️ Twilio Device unregistered');
        setCallStatus('initializing');
      });
      newDevice.on('error', (err) => {
        console.error('Twilio Device Error:', err.message);
        setCallStatus('error');
      });
      newDevice.on('incoming', (call) => {
        console.log('📞 Incoming call from:', call.parameters.From);
        setCallStatus('incoming');
        setActiveCall(call);
        call.on('accept', () => setCallStatus('on-call'));
        call.on('disconnect', () => { setCallStatus('ready'); setActiveCall(null); });
        call.on('reject', () => { setCallStatus('ready'); setActiveCall(null); });
        call.on('cancel', () => { setCallStatus('ready'); setActiveCall(null); });
      });

      deviceRef.current = newDevice;
      newDevice.register();
    } catch(e) {
      console.error('Device init failed:', e);
      setCallStatus('error');
    }
  };

  useEffect(() => {
    authFetch(`${API_BASE}/senders`).then(r => r.json()).then(setSenders).catch(()=>null);
    initializeDevice();
    authFetch(`${API_BASE}/me`).then(r => r.json()).then(data => setRole(data?.role || 'agent'));
    return () => { if (deviceRef.current) deviceRef.current.destroy(); };
  }, []);

  const makeCall = async (phoneNumber) => {
    const dev = deviceRef.current;
    if (!dev) return;
    if (dev.state !== 'registered') {
        await initializeDevice();
        return;
    }
    const call = await dev.connect({ params: { TargetNumber: phoneNumber } });
    setActiveCall(call);
    setCallStatus('on-call');
    call.on('disconnect', () => { setCallStatus('ready'); setActiveCall(null); });
  };
  const acceptCall = () => { if (activeCall) { activeCall.accept(); setCallStatus('on-call'); } };
  const endCall = () => { 
    if (activeCall) { 
      activeCall.disconnect(); 
      if (activeCall.status() === 'pending') activeCall.reject(); 
      setActiveCall(null); setCallStatus('ready'); 
    } 
  };

  return (
    <div className="flex flex-col md:flex-row h-[100dvh] bg-[#0b141a] text-white font-sans overflow-hidden">
      {/* GLOBAL CALL BANNER OVERLAY */}
      {activeCall && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-emerald-900/95 backdrop-blur border-b border-emerald-500 p-3 px-4 md:p-4 md:px-6 flex justify-between items-center shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-3">
            <div className="animate-pulse bg-emerald-500 p-2.5 rounded-full"><Mic size={18} className="text-white" /></div>
            <div>
              <h3 className="text-emerald-50 text-sm md:text-lg font-bold tracking-wide">{callStatus === 'incoming' ? 'Incoming Call...' : 'Active Call'}</h3>
              <p className="text-xs text-emerald-300 font-mono">{activeCall.customParameters?.get('From') || 'Direct Connection'}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {callStatus === 'incoming' && (
              <button onClick={acceptCall} className="bg-green-500 hover:bg-green-400 active:scale-95 text-green-950 px-4 md:px-8 py-2 md:py-3 rounded-full font-extrabold flex items-center gap-1.5 text-sm transition-transform">
                <Phone size={16} className="fill-current" /> Answer
              </button>
            )}
            <button onClick={endCall} className="bg-rose-600 hover:bg-rose-500 active:scale-95 text-white px-4 md:px-8 py-2 md:py-3 rounded-full font-bold flex items-center gap-1.5 text-sm transition-transform">
              <PhoneOff size={16} /> {callStatus === 'incoming' ? 'Decline' : 'End'}
            </button>
          </div>
        </div>
      )}

      {/* DESKTOP LEFT SIDEBAR — hidden on mobile */}
      <div className="hidden md:flex w-20 bg-[#111b21] flex-col items-center py-6 gap-8 border-r border-[#222d34] flex-shrink-0 z-40">
        <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-3 rounded-xl shadow-lg shadow-blue-500/20">
          <Zap className="text-white" size={24} />
        </div>
        <nav className="flex flex-col gap-4 w-full pt-4">
          {[
            { tab: 'inbox', icon: MessageCircle, label: 'Inbox' },
            { tab: 'leads', icon: Users, label: 'Leads' },
            { tab: 'campaigns', icon: Component, label: 'Campaigns' },
            ...(role === 'admin' ? [{ tab: 'admin', icon: User, label: 'Admin' }] : []),
          ].map(({ tab, icon: Icon, label }) => (
            <button key={tab} onClick={() => setActiveTab(tab)} title={label}
              className={`flex justify-center p-3 w-full border-l-2 transition-all group ${activeTab === tab ? (tab === 'admin' ? 'border-purple-500 text-purple-400 bg-purple-500/5' : 'border-blue-500 text-blue-400 bg-blue-500/5') : 'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
              <Icon size={26} className="group-hover:scale-110 transition-transform" />
            </button>
          ))}
        </nav>
        <button onClick={() => supabase.auth.signOut()} title="Log Out"
          className="mt-auto flex justify-center p-3 w-full border-l-2 border-transparent text-neutral-600 hover:text-rose-400 hover:border-rose-500 transition-all group">
          <LogOut size={22} className="group-hover:scale-110 transition-transform" />
        </button>
      </div>

      {/* MAIN CONTENT AREA */}
      <div className={`flex-1 flex overflow-hidden ${activeCall ? 'pt-[68px] md:pt-[88px]' : ''}`}>
        {activeTab === 'inbox' && <ErrorBoundary><InboxTab senders={senders} callStatus={callStatus} makeCall={makeCall} selectedContact={inboxSelectedContact} setSelectedContact={setInboxSelectedContact} /></ErrorBoundary>}
        {activeTab === 'admin' && role === 'admin' && <ErrorBoundary><AdminTab /></ErrorBoundary>}
        {activeTab === 'leads' && <ErrorBoundary><LeadsTab handleRouteToInbox={(c) => { setInboxSelectedContact(c); setActiveTab('inbox'); }} /></ErrorBoundary>}
        {activeTab === 'campaigns' && <ErrorBoundary><CampaignsTab senders={senders} /></ErrorBoundary>}
      </div>

      {/* MOBILE BOTTOM NAV — visible only on mobile */}
      <div className="md:hidden flex-shrink-0 bg-[#111b21] border-t border-[#222d34] flex items-center justify-around px-1 pt-2 pb-4 z-40">
        {[
          { tab: 'inbox', icon: MessageCircle, label: 'Inbox' },
          { tab: 'leads', icon: Users, label: 'Leads' },
          { tab: 'campaigns', icon: Component, label: 'Flows' },
          ...(role === 'admin' ? [{ tab: 'admin', icon: User, label: 'Admin' }] : []),
          { tab: '__logout__', icon: LogOut, label: 'Logout' },
        ].map(({ tab, icon: Icon, label }) => (
          <button key={tab}
            onClick={() => tab === '__logout__' ? supabase.auth.signOut() : setActiveTab(tab)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all active:scale-95 ${
              activeTab === tab ? 'text-blue-400' : 'text-neutral-500'
            }`}>
            <Icon size={22} />
            <span className="text-[10px] font-semibold tracking-wide">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}


// ==============================================================
// 1. INBOX TAB
// ==============================================================
const InboxTab = ({ senders, callStatus, makeCall, selectedContact, setSelectedContact }) => {
  const [contacts, setContacts] = useState([]);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [overrideSender, setOverrideSender] = useState(''); // sticky override
  const [showOverrideWarning, setShowOverrideWarning] = useState(false);
  const [newNumberDial, setNewNumberDial] = useState('');
  const [showDialer, setShowDialer] = useState(false);
  const messagesEndRef = useRef(null);

  const prevMsgCount = useRef(0);
  const prevContactId = useRef(null);
  const lastPollTimeRef = useRef(new Date().toISOString());
  const [soundEnabled, setSoundEnabled] = useState(true);

  // Bulk Delete State
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedForDeletion, setSelectedForDeletion] = useState(new Set());

  // Voicemail Drop state
  const [showVoicemailPanel, setShowVoicemailPanel] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState(null);
  const [recordedUrl, setRecordedUrl] = useState(null);
  const [savedVoicemails, setSavedVoicemails] = useState([]);
  const [dropStatus, setDropStatus] = useState(''); // '', 'uploading', 'dropping', 'done', 'error'
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  const smsRingtoneRef = useRef(null); // holds the stop function for the current ringtone

  const playDing = () => {
    // Stop any previous SMS ringtone first
    if (smsRingtoneRef.current) { smsRingtoneRef.current(); smsRingtoneRef.current = null; }

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();

      // 4-note ascending chime melody: C5 → E5 → G5 → C6 (bright, soft, distinct from call ring)
      const notes = [523.25, 659.25, 783.99, 1046.50];
      const noteDuration = 0.18;   // each note length (s)
      const noteGap = 0.04;        // silence between notes
      const cycleLength = notes.length * (noteDuration + noteGap); // ~0.88s per melody play
      const pauseBetweenCycles = 2.2; // gap between repeating the melody
      const maxDuration = 20;   // auto-stop after 20 seconds

      let stopped = false;
      let cycleTimeout = null;

      const playCycle = (startTime) => {
        if (stopped) return;
        notes.forEach((freq, i) => {
          const t = startTime + i * (noteDuration + noteGap);
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, t);
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.35, t + 0.02);
          gain.gain.setValueAtTime(0.35, t + noteDuration - 0.04);
          gain.gain.linearRampToValueAtTime(0, t + noteDuration);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(t); osc.stop(t + noteDuration + 0.05);
        });
      };

      const scheduleNext = (cycleNum) => {
        if (stopped) return;
        const elapsed = cycleNum * (cycleLength + pauseBetweenCycles);
        if (elapsed >= maxDuration) { ctx.close(); return; }
        playCycle(ctx.currentTime + (cycleNum === 0 ? 0 : 0));
        cycleTimeout = setTimeout(() => scheduleNext(cycleNum + 1), (cycleLength + pauseBetweenCycles) * 1000);
      };

      scheduleNext(0);

      // Return a stop function stored in the ref
      const stop = () => {
        stopped = true;
        if (cycleTimeout) clearTimeout(cycleTimeout);
        try { ctx.close(); } catch(e) {}
      };
      smsRingtoneRef.current = stop;

      // Auto-stop after maxDuration
      setTimeout(() => { if (smsRingtoneRef.current === stop) { stop(); smsRingtoneRef.current = null; } }, maxDuration * 1000);

    } catch(e) {}
  };

  // Stop ringtone on any user interaction with the page
  useEffect(() => {
    const stopOnInteract = () => { if (smsRingtoneRef.current) { smsRingtoneRef.current(); smsRingtoneRef.current = null; } };
    window.addEventListener('click', stopOnInteract);
    window.addEventListener('keydown', stopOnInteract);
    return () => { window.removeEventListener('click', stopOnInteract); window.removeEventListener('keydown', stopOnInteract); };
  }, []);

  const fetchSavedVoicemails = () =>
    authFetch(`${API_BASE}/voicemail/list`).then(r => r.json()).then(d => setSavedVoicemails(Array.isArray(d) ? d : [])).catch(() => {});

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob); setRecordedUrl(url);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecording(true);
    } catch(e) { alert('Microphone access denied: ' + e.message); }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  };

  const uploadAndDrop = async (vmUrl) => {
    if (!selectedContact) return;
    setDropStatus('dropping');
    const res = await authFetch(`${API_BASE}/voicemail/drop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: selectedContact.phone_number, voicemail_url: vmUrl }) });
    const d = await res.json();
    if (d.error) { setDropStatus('error'); alert('Drop failed: ' + d.error); }
    else setDropStatus('done');
  };

  const handleSaveAndDrop = async () => {
    if (!recordedBlob) return;
    setDropStatus('uploading');
    const fd = new FormData();
    fd.append('audio', recordedBlob, 'voicemail.webm');
    const res = await authFetch(`${API_BASE}/voicemail/upload`, { method: 'POST', body: fd });
    const d = await res.json();
    if (d.error) { setDropStatus('error'); alert('Upload failed: ' + d.error); return; }
    fetchSavedVoicemails();
    await uploadAndDrop(d.url);
  };

  const deleteVoicemail = async (path) => {
    await authFetch(`${API_BASE}/voicemail/file`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    fetchSavedVoicemails();
  };

  useEffect(() => {
    const isNewContact = prevContactId.current !== selectedContact?.id;
    const hasNewMsgs = messages.length !== prevMsgCount.current;
    if (isNewContact || hasNewMsgs) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      prevMsgCount.current = messages.length;
      prevContactId.current = selectedContact?.id;
    }
  }, [messages, selectedContact]);

  const loadData = (skipPoll = false) => {
    // 1. Fetch contacts for sidebar
    authFetch(`${API_BASE}/contacts`).then(r => r.json()).then(data => {
      if (!data.error) {
        setContacts(data);
        // Auto-resolve temporary contacts created during a new outbound call
        if (selectedContact?.id === 'temp') {
            const cleanTemp = selectedContact.phone_number.replace(/[^\d]/g, '');
            const match = data.find(c => c.phone_number.replace(/[^\d]/g, '') === cleanTemp);
            if (match) setSelectedContact(match);
        }
      }
    }).catch(()=>{});

    // 2. Safely poll for new inbound SMS to trigger chime.
    // We advance the timestamp BEFORE the fetch to prevent concurrent calls
    // from using the same `since` value and double-ringing for one message.
    if (soundEnabled && !skipPoll) {
      const pollSince = lastPollTimeRef.current;
      lastPollTimeRef.current = new Date().toISOString(); // advance immediately
      authFetch(`${API_BASE}/messages/poll-inbound?since=${encodeURIComponent(pollSince)}`)
        .then(r => r.json())
        .then(data => {
          if (data.new_messages) playDing();
        }).catch(()=>{});
    }

    // 3. Fetch active chat messages
    if (selectedContact?.id && selectedContact.id !== 'temp') {
      authFetch(`${API_BASE}/contacts/${selectedContact.id}/messages`).then(r => r.json()).then(data => !data.error && setMessages(data)).catch(()=>{});
    }
  };

  useEffect(() => { loadData(); fetchSavedVoicemails(); const i = setInterval(loadData, 2000); return () => clearInterval(i); }, [selectedContact, soundEnabled]);

  const selectContact = (contact) => {
    setSelectedContact(contact);
    setOverrideSender('');
    if (contact.id !== 'temp') authFetch(`${API_BASE}/contacts/${contact.id}/messages`).then(r => r.json()).then(data => !data.error && setMessages(data));
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!messageInput.trim() || !selectedContact) return;
    
    // Check Sticky Override
    if (overrideSender && selectedContact.assigned_sender_number && overrideSender !== selectedContact.assigned_sender_number && !showOverrideWarning) {
      setShowOverrideWarning(true);
      return; // halt and show warning
    }

    const payload = { to: selectedContact.phone_number, content: messageInput, override_from: overrideSender };
    setMessageInput('');
    setShowOverrideWarning(false);
    
    const tempId = Date.now();
    setMessages(prev => [...prev, { id: tempId, direction: 'outbound', content: payload.content, created_at: new Date().toISOString() }]);

    const res = await authFetch(`${API_BASE}/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await res.json();
    if (json.error) {
       alert("Failed to send message: " + json.error);
       // Remove optimistic message on failure
       setMessages(prev => prev.filter(m => m.id !== tempId));
    } else if (json.contactId) {
       // Auto-resolve temporary or fallback references to strictly lock onto DB index
       if (selectedContact.id === 'temp' || selectedContact.id !== json.contactId) {
           setSelectedContact(prev => ({ ...prev, id: json.contactId }));
       }
    }
    loadData(true); // skipPoll: we sent this ourselves, don't ding
  };
  
  const handleStartConversation = async (e) => {
     e.preventDefault();
     if (!newNumberDial.trim()) return;
     let existing = contacts.find(c => c.phone_number === newNumberDial);
     if (existing) { selectContact(existing); } else { setSelectedContact({ phone_number: newNumberDial, id: 'temp' }); setMessages([]); }
     setNewNumberDial(''); setShowDialer(false);
  };

  const handleDelete = async (targetId) => {
      if (window.confirm("WARNING: Are you sure you want to permanently delete this contact and all associated chat logs? This cannot be undone.")) {
          await authFetch(`${API_BASE}/contacts/${targetId}`, { method: 'DELETE' });
          setSelectedContact(null);
          loadData(true); // skipPoll: user-initiated action
      }
  };

  const handleBatchDelete = async () => {
      if (selectedForDeletion.size === 0) return;
      if (window.confirm(`WARNING: Are you sure you want to permanently delete ${selectedForDeletion.size} contacts and all associated chat logs? This cannot be undone.`)) {
          const res = await authFetch(`${API_BASE}/contacts/batch-delete`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contact_ids: Array.from(selectedForDeletion) })
          });
          const data = await res.json();
          if (data.error) {
              alert('Failed to delete: ' + data.error);
          } else {
              if (selectedContact && selectedForDeletion.has(selectedContact.id)) {
                  setSelectedContact(null);
              }
              setSelectedForDeletion(new Set());
              setIsSelectionMode(false);
              loadData(true); // skipPoll: user-initiated action
          }
      }
  };

  const toggleContactSelection = (id, e) => {
      e.stopPropagation();
      setSelectedForDeletion(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
      });
  };

  const toggleSelectAllContacts = () => {
      if (selectedForDeletion.size === contacts.length) {
          setSelectedForDeletion(new Set());
      } else {
          setSelectedForDeletion(new Set(contacts.map(c => c.id)));
      }
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* CONTACT LIST — hidden on mobile when a contact is selected */}
      <div className={`${selectedContact ? 'hidden md:flex' : 'flex'} w-full md:w-80 bg-[#111b21] border-r border-[#222d34] flex-col relative z-20`}>
        <div className="p-4 border-b border-[#222d34] flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <h1 className="text-lg font-bold text-neutral-100 flex items-center gap-2"><MessageCircle size={20} className="text-blue-500"/> Inbox</h1>
            <div className="flex gap-2">
              <button onClick={() => { setIsSelectionMode(!isSelectionMode); setSelectedForDeletion(new Set()); }} title={isSelectionMode ? 'Cancel Selection' : 'Batch Delete'} className={`p-2 rounded-full transition text-sm h-8 w-8 flex items-center justify-center ${isSelectionMode ? 'bg-rose-700/30 text-rose-400 hover:bg-rose-700/50' : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'}`}>
                <Trash2 size={16} />
              </button>
              <button onClick={() => setSoundEnabled(s => !s)} title={soundEnabled ? 'Mute SMS sounds' : 'Enable SMS sounds'} className={`p-2 rounded-full transition text-sm h-8 w-8 flex items-center justify-center ${soundEnabled ? 'bg-emerald-700/30 text-emerald-400 hover:bg-emerald-700/50' : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'}`}>
                {soundEnabled ? '🔔' : '🔕'}
              </button>
              <button onClick={() => setShowDialer(!showDialer)} className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 p-2 rounded-full transition shadow h-8 w-8 flex items-center justify-center"><Plus size={16} /></button>
            </div>
          </div>
          {isSelectionMode && (
            <div className="flex justify-between items-center bg-[#202c33] p-2 rounded-lg border border-[#2a3942] animate-in slide-in-from-top-2">
               <div className="flex items-center gap-2">
                 <input type="checkbox" className="w-4 h-4 rounded border-neutral-600 accent-blue-500 cursor-pointer" checked={contacts.length > 0 && selectedForDeletion.size === contacts.length} onChange={toggleSelectAllContacts} />
                 <span className="text-xs text-neutral-400 font-semibold">{selectedForDeletion.size} Selected</span>
               </div>
               {selectedForDeletion.size > 0 && (
                 <button onClick={handleBatchDelete} className="text-xs bg-rose-600 hover:bg-rose-500 text-white px-3 py-1.5 rounded font-bold shadow transition active:scale-95">Delete All</button>
               )}
            </div>
          )}
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {contacts.map(c => (
            <div key={c.id} onClick={() => !isSelectionMode && selectContact(c)} className={`p-4 border-b border-[#2a3942]/40 ${!isSelectionMode ? 'cursor-pointer active:bg-[#202c33] hover:bg-[#202c33]' : ''} transition ${selectedContact?.id === c.id && !isSelectionMode ? 'bg-[#2a3942] border-l-4 border-l-blue-500' : ''}`}>
              <div className="flex items-center gap-3">
                {isSelectionMode && (
                  <input type="checkbox" className="w-5 h-5 rounded border-neutral-600 accent-blue-500 cursor-pointer flex-shrink-0" checked={selectedForDeletion.has(c.id)} onChange={(e) => toggleContactSelection(c.id, e)} onClick={(e) => e.stopPropagation()} />
                )}
                <div className="w-11 h-11 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-full flex items-center justify-center flex-shrink-0 shadow-md">
                  <User size={20} className="text-white" />
                </div>
                <div className="flex-1 min-w-0" onClick={(e) => { if(isSelectionMode) toggleContactSelection(c.id, e) }}>
                  <div className="flex justify-between items-baseline mb-0.5">
                    <h3 className="font-semibold text-neutral-100 truncate text-sm cursor-pointer">{c.name || c.phone_number}</h3>
                    <span className="text-[10px] text-neutral-500 flex-shrink-0 ml-2">
                      {new Date(c.updated_at).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) + ', ' + new Date(c.updated_at).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                  <p className="text-xs text-neutral-400 truncate cursor-pointer">{c.last_message}</p>
                </div>
              </div>
            </div>
          ))}
          {contacts.length === 0 && <div className="p-8 text-center text-neutral-600 text-sm">No active conversations.</div>}
        </div>
        
        {showDialer && (
          <div className="absolute inset-0 bg-[#111b21]/95 backdrop-blur-sm z-30 flex flex-col p-6 animate-in slide-in-from-bottom-2 duration-200">
            <div className="flex justify-between items-center mb-8">
              <h3 className="font-medium text-neutral-300">New Chat</h3>
              <button onClick={() => setShowDialer(false)} className="text-neutral-500 hover:text-white p-2">&times;</button>
            </div>
            <form onSubmit={handleStartConversation} className="flex flex-col gap-4">
              <input autoFocus type="text" placeholder="+1..." value={newNumberDial} onChange={e => setNewNumberDial(e.target.value)} className="p-3 bg-[#202c33] border border-[#2a3942] rounded-xl outline-none text-white focus:border-blue-500 font-mono text-center text-lg shadow-inner" />
              <button type="submit" disabled={!newNumberDial} className="bg-blue-600 disabled:opacity-50 text-white rounded-xl p-3 font-semibold flex items-center justify-center gap-2 mt-2"><MessageCircle size={18} /> Start Chat</button>
            </form>
          </div>
        )}
      </div>

      {/* CHAT PANEL — full screen on mobile, right pane on desktop */}
      <div className={`${selectedContact ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-[#0b141a] relative bg-[url('https://www.transparenttextures.com/patterns/cartographer.png')] bg-blend-overlay`}>
        {selectedContact ? (
          <>
            {/* Chat Header */}
            <div className="bg-[#202c33] p-3 md:p-4 px-4 md:px-6 border-b border-[#2a3942] flex justify-between items-center z-10 shadow-sm">
              <div className="flex items-center gap-3">
                {/* Mobile back button */}
                <button onClick={() => setSelectedContact(null)} className="md:hidden p-1.5 -ml-1 text-neutral-400 hover:text-white transition active:scale-95">
                  <ArrowLeft size={22} />
                </button>
                <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-full flex items-center justify-center shadow-md flex-shrink-0">
                  <User size={20} className="text-white" />
                </div>
                <div>
                  <h2 className="text-base md:text-lg font-bold text-neutral-50 truncate max-w-[160px] md:max-w-none">{selectedContact.name || selectedContact.phone_number}</h2>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_5px_#10b981]"></span>
                    <p className="text-[10px] font-medium text-neutral-400 capitalize tracking-wide">
                      {selectedContact.assigned_sender_number ? `Locked to ${selectedContact.assigned_sender_number}` : 'No Sticky Assigned'}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setShowVoicemailPanel(v => !v); setDropStatus(''); setRecordedBlob(null); setRecordedUrl(null); }} className={`p-2 rounded-full transition active:scale-95 text-sm ${showVoicemailPanel ? 'bg-purple-600 text-white' : 'bg-purple-600/20 hover:bg-purple-600/40 text-purple-400'}`} title="Voicemail Drop">
                  <Mic size={15} />
                </button>
                <button onClick={() => handleDelete(selectedContact.id)} disabled={selectedContact.id === 'temp'} className="p-2 rounded-full transition bg-rose-600/20 hover:bg-rose-500 text-rose-500 hover:text-white disabled:opacity-50 active:scale-95">
                  <Trash2 size={15} />
                </button>
                <button onClick={() => makeCall(selectedContact.phone_number)} disabled={callStatus !== 'ready'} className={`p-2 px-4 md:px-6 rounded-full flex items-center gap-1.5 transition font-medium shadow-md active:scale-95 text-sm ${callStatus === 'ready' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-neutral-800 text-neutral-600 cursor-not-allowed'}`}>
                  <Phone size={15} className="fill-current opacity-80" />
                  <span className="hidden sm:inline">{callStatus === 'initializing' ? 'Connecting...' : 'Call'}</span>
                </button>
              </div>
            </div>

            {/* VOICEMAIL DROP PANEL */}
            {showVoicemailPanel && (
              <div className="bg-[#111b21] border-b border-[#2a3942] p-4 z-10 shadow-inner">
                <div className="max-w-xl mx-auto">
                  <h3 className="text-sm font-bold text-purple-400 mb-3 flex items-center gap-2"><Mic size={14}/> Voicemail Drop — {selectedContact.name || selectedContact.phone_number}</h3>
                  
                  {/* Recording Controls */}
                  <div className="flex gap-3 items-center mb-3">
                    {!isRecording ? (
                      <button onClick={startRecording} className="flex items-center gap-2 bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-lg text-sm font-bold transition active:scale-95 shadow">
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span> Record New
                      </button>
                    ) : (
                      <button onClick={stopRecording} className="flex items-center gap-2 bg-neutral-700 hover:bg-neutral-600 text-white px-4 py-2 rounded-lg text-sm font-bold transition active:scale-95 animate-pulse">
                        <span className="w-2 h-2 rounded-full bg-rose-500"></span> Stop Recording
                      </button>
                    )}
                    {recordedUrl && (
                      <audio controls src={recordedUrl} className="h-8 flex-1 max-w-[220px]" />
                    )}
                    {recordedBlob && (
                      <button onClick={handleSaveAndDrop} disabled={!!dropStatus && dropStatus !== 'error'} className="ml-auto flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-bold transition active:scale-95 shadow">
                        {dropStatus === 'uploading' ? '⬆️ Uploading...' : dropStatus === 'dropping' ? '📞 Dropping...' : dropStatus === 'done' ? '✅ Dropped!' : '📤 Save & Drop'}
                      </button>
                    )}
                  </div>

                  {/* Saved Voicemails Library */}
                  {savedVoicemails.length > 0 && (
                    <div>
                      <p className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold mb-2">Saved Library</p>
                      <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                        {savedVoicemails.map(vm => (
                          <div key={vm.path} className="flex items-center gap-2 bg-[#202c33] border border-[#2a3942] rounded-lg p-2">
                            <audio controls src={vm.url} className="h-7 flex-1 min-w-0" />
                            <button onClick={() => uploadAndDrop(vm.url)} disabled={dropStatus === 'dropping'} className="shrink-0 bg-purple-600/30 hover:bg-purple-600 text-purple-300 hover:text-white px-3 py-1 rounded-md text-xs font-bold transition">Drop</button>
                            <button onClick={() => deleteVoicemail(vm.path)} className="shrink-0 text-rose-500/50 hover:text-rose-400 p-1"><Trash2 size={13}/></button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-3 relative z-10">
              {messages.map(msg => {
                const isOut = msg.direction === 'outbound';
                return (
                  <div key={msg.id} className={`flex relative z-10 ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[82%] md:max-w-[75%] rounded-xl px-4 py-2.5 shadow text-[14px] leading-relaxed ${isOut ? 'bg-[#005c4b] text-[#e9edef] rounded-tr-none' : 'bg-[#202c33] text-[#e9edef] rounded-tl-none'}`}>
                      {msg.type === 'call' && (() => {
                          const parts = msg.content.split('|||');
                          const callText = parts[0].trim();
                          let aiData = null;
                          if (parts.length > 1) {
                             try { aiData = JSON.parse(parts[1].trim()); } catch(e){}
                          }
                          return (
                            <div className="flex flex-col gap-2">
                              <div className="mb-2 p-3 bg-[#111b21]/60 rounded-xl border border-neutral-700/50 flex flex-col gap-3 shadow-inner">
                                <div className="flex items-center gap-2 text-blue-400 font-bold text-xs"><PhoneCall size={14} /> {msg.direction === 'inbound' ? 'Incoming' : 'Outgoing'} Call</div>
                                {msg.recording_url && <audio controls controlsList="nodownload" src={`${API_BASE}/recordings?url=${encodeURIComponent(msg.recording_url)}`} className="h-8 max-w-[220px]" />}
                                {aiData && (
                                   <div className="mt-1 pt-3 border-t border-neutral-700/50">
                                      <p className="text-xs font-bold text-purple-400 mb-1 flex items-center gap-1.5"><Sparkles size={12}/> AI Summary</p>
                                      <p className="text-[13px] text-neutral-300 italic leading-relaxed mb-3">{aiData.summary}</p>
                                      <details className="group">
                                         <summary className="text-xs font-medium text-blue-400 cursor-pointer hover:text-blue-300 transition select-none flex items-center gap-1">
                                            <span className="group-open:hidden">▶ View Transcript</span>
                                            <span className="hidden group-open:inline">▼ Hide Transcript</span>
                                         </summary>
                                         <div className="mt-2 p-2 bg-black/30 rounded-lg border border-neutral-800 text-[12px] text-neutral-400 max-h-48 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                                            {aiData.transcription}
                                         </div>
                                      </details>
                                   </div>
                                )}
                              </div>
                              {!msg.recording_url && !aiData && <p className="whitespace-pre-wrap italic opacity-80">{callText}</p>}
                            </div>
                          );
                      })()}
                      {msg.type !== 'call' && <p className="whitespace-pre-wrap">{msg.content}</p>}
                      <div className="flex justify-end items-center mt-1 opacity-60">
                        <span className="text-[9px] uppercase">
                          {new Date(msg.created_at).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) + ', ' + new Date(msg.created_at).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit'})}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>

            {/* Message Input */}
            <div className="p-3 md:p-4 px-4 md:px-6 bg-[#202c33] border-t border-[#2a3942] z-10 flex flex-col gap-2">
              {showOverrideWarning && (
                <div className="bg-rose-900/30 border border-rose-500/50 p-3 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-lg mb-1 animate-in fade-in slide-in-from-bottom-2">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="text-rose-400 flex-shrink-0 mt-0.5" size={18} />
                    <div>
                      <p className="text-sm font-semibold text-rose-100">Sticky Override Warning!</p>
                      <p className="text-xs text-rose-300">Changing the "From" number will break thread continuity.</p>
                    </div>
                  </div>
                  <div className="flex gap-2 self-end sm:self-auto">
                    <button onClick={() => setShowOverrideWarning(false)} className="text-xs bg-neutral-800 hover:bg-neutral-700 px-3 py-1.5 rounded-lg text-white">Cancel</button>
                    <button onClick={handleSend} className="text-xs bg-rose-600 hover:bg-rose-500 px-3 py-1.5 rounded-lg text-white font-semibold">Yes, Override</button>
                  </div>
                </div>
              )}
              <div className="flex justify-between items-center px-1 mb-1">
                <p className="text-xs text-neutral-500 tracking-wide font-semibold uppercase">Reply using:</p>
                <select
                  value={overrideSender || selectedContact.assigned_sender_number || senders[0]?.phone_number}
                  onChange={e => setOverrideSender(e.target.value)}
                  className="bg-[#2a3942] text-xs text-blue-300 px-3 py-1 rounded outline-none border border-[#111b21] max-w-[160px] truncate">
                  {senders.map(s => <option key={s.id} value={s.phone_number}>{s.name || s.phone_number}</option>)}
                </select>
              </div>
              
              {(() => {
                 let customVars = {};
                 let keys = [];
                 try {
                     if (selectedContact?.custom_variables) {
                         customVars = typeof selectedContact.custom_variables === 'string' ? JSON.parse(selectedContact.custom_variables) : selectedContact.custom_variables;
                         keys = Object.keys(customVars || {});
                     }
                 } catch(e) {}
                 return keys.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 pb-1.5 pt-1 border-b border-[#2a3942]/50 mb-2">
                      <span className="text-[9px] text-emerald-500/70 uppercase tracking-widest font-bold flex items-center w-full">Insert Variable:</span>
                      {keys.map(k => (
                        <button type="button" key={k} onClick={() => setMessageInput(prev => prev + (prev.endsWith(' ') || prev==='' ? '' : ' ') + customVars[k])} className="text-[10px] bg-[#111b21] border border-[#2a3942] hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400 px-2 py-1 rounded-md text-neutral-400 whitespace-nowrap transition-colors flex-shrink-0">
                          {k}
                        </button>
                      ))}
                    </div>
                 ) : null;
              })()}
              
              <form onSubmit={handleSend} className="flex gap-2">
                <input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} placeholder="Type a message..." className="flex-1 bg-[#2a3942] border border-[#111b21] rounded-xl px-4 py-3 text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition placeholder:text-neutral-500 text-sm" />
                <button type="submit" disabled={!messageInput.trim()} className="bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white w-12 rounded-xl flex items-center justify-center transition-all shadow hover:bg-emerald-500 active:scale-95 group">
                  <Send size={18} className="ml-0.5 group-disabled:opacity-50" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col text-neutral-600 p-8 z-10">
            <MessageCircle size={56} className="text-neutral-800 drop-shadow-md mb-4" strokeWidth={1} />
            <p className="max-w-xs text-center text-sm font-medium">Select a chat to view threads or start a fresh connection.</p>
          </div>
        )}
      </div>
    </div>
  );
};


// ==============================================================
// 2. LEADS TAB (CSV Uploads)
// ==============================================================
const LeadsTab = ({ handleRouteToInbox }) => {
    const [lists, setLists] = useState([]);
    const [file, setFile] = useState(null);
    const [listName, setListName] = useState('');
    const [uploading, setUploading] = useState(false);
    
    const [viewingList, setViewingList] = useState(null);
    const [listContacts, setListContacts] = useState([]);
    
    // Batch Selection State
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [isPushing, setIsPushing] = useState(false);

    const fetchLists = () => authFetch(`${API_BASE}/lists`).then(r=>r.json()).then(setLists).catch(()=>{});
    useEffect(() => { fetchLists(); }, []);

    const handleUpload = async (e) => {
        e.preventDefault();
        if (!file) return;
        setUploading(true);
        const data = new FormData();
        data.append('file', file);
        data.append('name', listName || 'Imported List');
        
        authFetch(`${API_BASE}/lists/upload`, { method: 'POST', body: data }).then(r=>r.json()).then(d => {
            setUploading(false); setFile(null); setListName(''); fetchLists();
        }).catch(err => { console.error(err); setUploading(false); });
    };

    const handleDeleteList = async (id, e) => {
        e.stopPropagation();
        if(!window.confirm('Delete list? This permanently unmaps the targets from this specific list definition and cancels their queue routines.')) return;
        await authFetch(`${API_BASE}/lists/${id}`, { method: 'DELETE' });
        if (viewingList?.id === id) setViewingList(null);
        fetchLists();
    };

    const handleViewLeads = async (list) => {
        setViewingList(list);
        setListContacts([]);
        setSelectedIds(new Set());
        authFetch(`${API_BASE}/lists/${list.id}/contacts`).then(r => r.json()).then(setListContacts).catch(()=>{});
    };

    const toggleSelection = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === listContacts.filter(c => !c.last_message).length) {
            setSelectedIds(new Set()); // Deselect all
        } else {
            // Select only those that don't already have a last_message
            setSelectedIds(new Set(listContacts.filter(c => !c.last_message).map(c => c.id)));
        }
    };

    const handlePushToInbox = async () => {
        if (selectedIds.size === 0) return;
        setIsPushing(true);
        const res = await authFetch(`${API_BASE}/contacts/push-to-inbox`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_ids: Array.from(selectedIds) })
        });
        const data = await res.json();
        setIsPushing(false);
        if (data.error) {
            alert('Failed to push: ' + data.error);
        } else {
            // Refresh contacts locally to show them as pushed
            setListContacts(prev => prev.map(c => selectedIds.has(c.id) ? { ...c, last_message: '[ Added to Inbox ]' } : c));
            setSelectedIds(new Set());
            alert('Successfully pushed to Inbox!');
        }
    };

    return (
        <div className="flex-1 flex flex-col bg-[#111b21] relative ${(activeCall && activeTab !== 'campaigns') ? 'pt-[88px]' : ''}">
            <div className="h-20 border-b border-[#222d34] flex items-center px-10 bg-[#111b21] shrink-0 sticky top-0 z-20">
               <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-teal-500 bg-clip-text text-transparent flex items-center gap-3"><Users size={28} className="text-emerald-400" /> Lead Storage</h1>
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-8 relative">
                <div className="lg:col-span-1 bg-[#202c33] rounded-2xl p-6 h-fit border border-[#2a3942] shadow-xl">
                    <h2 className="text-lg font-semibold mb-6 flex items-center gap-2 text-neutral-200"><UploadCloud className="text-blue-400" size={20}/> Import Leads (CSV)</h2>
                    <form onSubmit={handleUpload} className="flex flex-col gap-5">
                       <div>
                           <label className="text-xs text-neutral-400 uppercase tracking-widest font-semibold block mb-2">List Name</label>
                           <input value={listName} onChange={e=>setListName(e.target.value)} type="text" placeholder="e.g. November Cold Leads" className="w-full bg-[#111b21] border border-[#2a3942] p-3 rounded-lg text-sm text-white focus:outline-none focus:border-blue-500"/>
                       </div>
                       <div>
                           <label className="text-xs text-neutral-400 uppercase tracking-widest font-semibold block mb-2">CSV File</label>
                           <div className="border border-dashed border-[#2a3942] bg-[#111b21] rounded-lg p-5 flex items-center justify-center relative overflow-hidden transition-colors hover:border-blue-500 group">
                              <input type="file" required accept=".csv" onChange={e=>setFile(e.target.files[0])} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                              <div className="text-center">
                                 <Plus size={24} className="text-neutral-500 mx-auto mb-2 group-hover:text-blue-400 transition-colors" />
                                 <p className="text-xs text-neutral-400 font-medium">{file ? file.name : 'Click or Drag CSV here'}</p>
                              </div>
                           </div>
                       </div>
                       <button disabled={!file || uploading} className="bg-blue-600 disabled:opacity-50 hover:bg-blue-500 p-3 rounded-lg text-sm font-bold text-white transition-all shadow mt-2">{uploading ? 'Importing database...' : 'Upload & Process'}</button>
                    </form>
                </div>
                
                <div className="lg:col-span-2">
                    <h2 className="text-lg font-semibold mb-6 text-neutral-200">Your Lists</h2>
                    <div className="space-y-4">
                        {lists.map(list => (
                            <div key={list.id} className="bg-[#202c33] border border-[#2a3942] rounded-xl p-5 flex justify-between items-center shadow-md group hover:border-[#3a4f5c] transition-colors">
                                <div>
                                    <h3 className="font-bold text-neutral-100 text-lg mb-1">{list.name}</h3>
                                    <p className="text-xs text-neutral-500 font-mono tracking-wider">{new Date(list.created_at).toLocaleDateString()}</p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="bg-[#111b21] border border-[#2a3942] px-4 py-2 rounded-lg flex flex-col items-center justify-center mr-2">
                                        <span className="text-blue-400 font-bold text-lg">{list.lead_count || 0}</span>
                                        <span className="text-[9px] uppercase text-neutral-500 font-semibold tracking-widest">Leads</span>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); handleViewLeads(list); }} className="text-blue-400 hover:text-blue-300 p-2.5 border border-[#2a3942] hover:border-blue-500/50 rounded-lg transition-colors flex items-center justify-center bg-[#111b21] shadow-sm active:scale-95" title="View Leads Array">
                                        <Users size={16} />
                                    </button>
                                    <button onClick={(e) => handleDeleteList(list.id, e)} className="text-rose-500 hover:text-rose-400 p-2.5 border border-[#2a3942] hover:border-rose-500/50 rounded-lg transition-colors flex items-center justify-center bg-[#111b21] shadow-sm active:scale-95 opacity-0 group-hover:opacity-100" title="Permanently Delete List">
                                        <Trash2 size={16} />
                                    </button>
                                </div>
                            </div>
                        ))}
                        {lists.length === 0 && <div className="text-neutral-600 text-sm text-center py-10 bg-[#202c33] rounded-xl border border-dashed border-[#2a3942]">No imported lead lists found. Upload a CSV to get started.</div>}
                    </div>
                </div>
            </div>

            {/* VIEW LEADS OVERLAY MODAL */}
            {viewingList && (
                <div className="fixed inset-0 z-50 bg-[#0b141a]/90 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-[#111b21] border border-[#2a3942] rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="p-5 border-b border-[#2a3942] flex justify-between items-center bg-[#202c33]">
                           <div>
                               <h2 className="text-lg font-bold text-white flex items-center gap-2"><Users size={20} className="text-blue-400"/> {viewingList.name}</h2>
                               <p className="text-xs text-neutral-400 mt-1 font-mono">Found {listContacts.length} extracted contacts</p>
                           </div>
                           <div className="flex items-center gap-3">
                               {selectedIds.size > 0 && (
                                   <button onClick={handlePushToInbox} disabled={isPushing} className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-bold shadow-md transition-all active:scale-95 flex items-center gap-2">
                                       {isPushing ? 'Pushing...' : `Push ${selectedIds.size} to Inbox`} <MessageCircle size={16} />
                                   </button>
                               )}
                               <button onClick={()=>setViewingList(null)} className="text-neutral-500 hover:text-white p-2 transition text-2xl leading-none">&times;</button>
                           </div>
                        </div>
                        
                        {listContacts.length > 0 && (
                            <div className="bg-[#111b21] px-6 py-3 border-b border-[#2a3942] flex items-center gap-4">
                                <input 
                                    type="checkbox" 
                                    className="w-4 h-4 rounded border-neutral-600 accent-blue-500 cursor-pointer"
                                    checked={listContacts.length > 0 && selectedIds.size === listContacts.filter(c => !c.last_message).length && listContacts.filter(c => !c.last_message).length > 0}
                                    onChange={toggleSelectAll}
                                />
                                <span className="text-xs text-neutral-400 uppercase tracking-widest font-semibold">Select All Unpushed</span>
                            </div>
                        )}
                        <div className="flex-1 overflow-y-auto p-4 space-y-2 relative">
                            {listContacts.length === 0 ? (
                                <div className="text-center p-10 text-neutral-500 text-sm flex flex-col items-center">
                                    <span className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin mb-4"></span>
                                    Loading extracted grid arrays...
                                </div>
                            ) : (
                                listContacts.map(c => (
                                    <div key={c.id} className={`flex flex-col sm:flex-row justify-between items-start sm:items-center p-4 bg-[#202c33] border rounded-xl transition-colors gap-3 scroll-m-2 ${selectedIds.has(c.id) ? 'border-blue-500 bg-blue-900/10' : 'border-[#2a3942] hover:border-[#3a4f5c]'}`}>
                                        <div className="flex items-center gap-4 w-full sm:w-auto">
                                            <input 
                                                type="checkbox" 
                                                className="w-4 h-4 rounded border-neutral-600 accent-blue-500 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                                                checked={selectedIds.has(c.id)}
                                                disabled={!!c.last_message}
                                                onChange={() => toggleSelection(c.id)}
                                            />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <p className="font-bold text-neutral-200 text-lg sm:text-base font-mono">{c.phone_number}</p>
                                                    {c.last_message && <span className="text-[9px] bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded font-semibold uppercase tracking-widest">In Inbox</span>}
                                                </div>
                                                <p className="text-[10px] sm:text-xs text-emerald-500/80 truncate max-w-full font-mono bg-[#111b21] p-1.5 rounded inline-block border border-[#2a3942]/60">
                                                    {c.custom_variables && c.custom_variables !== '{}' ? c.custom_variables : 'No variables injected'}
                                                </p>
                                            </div>
                                        </div>
                                        <button onClick={() => { setViewingList(null); handleRouteToInbox(c); }} className="w-full sm:w-auto px-6 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-sm font-bold rounded-lg shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 shrink-0">
                                           <MessageCircle size={16} /> Msg
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};


// ==============================================================
// 3. CAMPAIGNS TAB (Sequencer Builder)
// ==============================================================
const CampaignsTab = ({ senders }) => {
    const [campaigns, setCampaigns] = useState([]);
    const [lists, setLists] = useState([]);
    const fetchCampaigns = () => authFetch(`${API_BASE}/campaigns`).then(r=>r.json()).then(setCampaigns).catch(()=>{});
    useEffect(() => { fetchCampaigns(); authFetch(`${API_BASE}/lists`).then(r=>r.json()).then(setLists).catch(()=>{}); }, []);

    const [isCreating, setIsCreating] = useState(false);
    
    const [cName, setCName] = useState('');
    const [cList, setCList] = useState('');
    const [cSenders, setCSenders] = useState([]);
    const [cDripRate, setCDripRate] = useState(0);
    const [steps, setSteps] = useState([{ delay_minutes: 0, content: '' }]);
    const [listColumns, setListColumns] = useState([]);

    useEffect(() => {
        if (!cList) {
            setListColumns([]); return;
        }
        authFetch(`${API_BASE}/lists/${cList}/columns`)
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(cols => setListColumns(Array.isArray(cols) ? cols : []))
            .catch(() => setListColumns([]));
    }, [cList]);

    const toggleSender = (num) => {
        if (cSenders.includes(num)) setCSenders(cSenders.filter(n => n !== num));
        else setCSenders([...cSenders, num]);
    };

    const addStep = () => setSteps([...steps, { delay_minutes: 60, content: '' }]);
    const updateStep = (idx, field, val) => { const st = [...steps]; st[idx][field] = val; setSteps(st); };
    const removeStep = (idx) => { if(steps.length>1) { const st = [...steps]; st.splice(idx,1); setSteps(st); } };

    const handleCreate = async () => {
        if(!cName || !cList || cSenders.length===0 || !steps[0].content) return alert("Fill all required fields!");
        const payload = { name: cName, list_id: cList, sender_pool: cSenders, steps, drip_rate: Number(cDripRate) };
        await authFetch(`${API_BASE}/campaigns`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        setIsCreating(false); fetchCampaigns();
    };

    if (isCreating) {
        return (
            <div className="flex-1 bg-[#111b21] overflow-y-auto">
                <div className="max-w-4xl mx-auto py-12 px-6">
                   <div className="flex justify-between items-center mb-8">
                       <h2 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">New Campaign Builder</h2>
                       <button onClick={()=>setIsCreating(false)} className="text-neutral-500 hover:text-white px-4 py-2">Cancel</button>
                   </div>

                   <div className="space-y-8">
                       <div className="bg-[#202c33] border border-[#2a3942] rounded-2xl p-8 shadow-xl">
                           <h3 className="text-lg font-bold mb-6 text-neutral-100 pb-4 border-b border-[#2a3942]">1. Setup Configurations</h3>
                           <div className="grid grid-cols-2 gap-6">
                               <div>
                                   <label className="text-xs uppercase text-neutral-400 font-bold block mb-2 tracking-wider">Campaign Name</label>
                                   <input value={cName} onChange={(e)=>setCName(e.target.value)} type="text" placeholder="E.g. Q4 Outreach" className="w-full bg-[#111b21] border border-[#2a3942] p-3 rounded-xl focus:border-blue-500 outline-none text-white text-sm" />
                               </div>
                               <div>
                                   <label className="text-xs uppercase text-neutral-400 font-bold block mb-2 tracking-wider">Target Lead List</label>
                                   <select value={cList} onChange={(e)=>setCList(e.target.value)} className="w-full bg-[#111b21] border border-[#2a3942] p-3 rounded-xl focus:border-blue-500 outline-none text-white text-sm">
                                       <option value="">-- Select a List --</option>
                                       {lists.map(l => <option key={l.id} value={l.id}>{l.name} ({l.lead_count} leads)</option>)}
                                   </select>
                               </div>
                               <div>
                                   <label className="text-xs uppercase text-neutral-400 font-bold block mb-2 tracking-wider">Throttle Drip (Msgs per Min)</label>
                                   <input value={cDripRate} onChange={(e)=>setCDripRate(e.target.value)} type="number" placeholder="0 = unlimited" className="w-full bg-[#111b21] border border-[#2a3942] p-3 rounded-xl focus:border-blue-500 outline-none text-white text-sm" />
                               </div>
                           </div>
                           
                           <div className="mt-8">
                               <label className="text-xs uppercase text-neutral-400 font-bold block mb-2 tracking-wider">Sender Multi-Number Pool</label>
                               <div className="flex flex-wrap gap-3 mt-3">
                                   {senders.map(s => {
                                       const isSel = cSenders.includes(s.phone_number);
                                       return (
                                          <div key={s.id} onClick={()=>toggleSender(s.phone_number)} className={`px-4 py-2 border rounded-full text-sm cursor-pointer transition-all flex items-center gap-2 ${isSel ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400' : 'border-[#2a3942] bg-[#111b21] text-neutral-400 hover:border-neutral-500'}`}>
                                              {isSel && <CheckCircle size={14} />} {s.phone_number} {s.name && `(${s.name})`}
                                          </div>
                                       );
                                   })}
                               </div>
                               <p className="text-xs text-neutral-500 mt-3 font-medium">Any numbers checked above will automatically be permanently assigned contextually to leads as sticky-senders when this sequence starts.</p>
                           </div>
                       </div>

                       <div className="bg-[#202c33] border border-[#2a3942] rounded-2xl p-8 shadow-xl">
                           <h3 className="text-lg font-bold mb-6 text-neutral-100 pb-4 border-b border-[#2a3942]">2. Sequence Steps Builder</h3>
                           <div className="space-y-6">
                               {steps.map((st, i) => (
                                   <div key={i} className="flex gap-4 items-start relative pl-8 before:absolute before:left-[15px] before:top-10 before:bottom-[-24px] before:w-0.5 before:bg-[#2a3942] last:before:hidden">
                                       <div className="absolute left-0 top-3 w-8 h-8 rounded-full bg-[#111b21] border border-[#2a3942] flex items-center justify-center font-bold text-xs text-neutral-400 shadow">{i+1}</div>
                                       
                                       <div className="flex-1 bg-[#111b21] border border-[#2a3942] rounded-xl p-5 relative group">
                                           {i > 0 && (
                                              <div className="mb-4 bg-[#202c33] border border-[#2a3942] inline-flex rounded-lg overflow-hidden items-center shadow-inner">
                                                  <span className="px-3 text-xs font-semibold text-neutral-400 uppercase tracking-widest border-r border-[#2a3942]">Wait Delay</span>
                                                  <input type="number" value={st.delay_minutes} onChange={e=>updateStep(i, 'delay_minutes', e.target.value)} className="w-20 bg-transparent py-1.5 px-3 text-sm text-center outline-none text-blue-400 font-bold" />
                                                  <span className="px-3 text-xs font-medium text-neutral-500 border-l border-[#2a3942]">Minutes</span>
                                              </div>
                                           )}
                                           <textarea rows={3} placeholder="Write SMS message content..." value={st.content} onChange={e=>updateStep(i, 'content', e.target.value)} className="w-full bg-transparent outline-none text-sm text-neutral-100 resize-none font-medium leading-relaxed mb-1"></textarea>
                                           
                                           {listColumns.length > 0 ? (
                                              <div className="mt-2 flex flex-wrap gap-1.5 pb-2 border-t border-[#2a3942]/40 pt-2">
                                                <span className="text-[9px] text-emerald-500/70 uppercase tracking-widest font-bold block w-full mb-0.5">{'Inject {{Col}}:'}</span>
                                                {listColumns.map(col => (
                                                  <button type="button" key={col} onClick={() => updateStep(i, 'content', st.content + (st.content.endsWith(' ') || st.content==='' ? '' : ' ') + `{{${col}}}`)} className="text-[10px] bg-[#111b21] border border-[#2a3942] hover:border-emerald-500 hover:bg-emerald-500/10 hover:text-emerald-400 px-2 py-1 rounded-md text-neutral-400 whitespace-nowrap transition-all shadow-sm">
                                                    {col}
                                                  </button>
                                                ))}
                                              </div>
                                           ) : (
                                              <p className="text-[10px] text-emerald-400/80 mb-2 font-mono">Tip: Select a Lead List above to dynamically inject custom CSV column names like {'{{firstName}}'}</p>
                                           )}
                                           
                                           {steps.length > 1 && <button onClick={()=>removeStep(i)} className="absolute top-4 right-4 text-xs font-bold text-rose-500/50 hover:text-rose-500 transition-colors uppercase tracking-widest">Remove</button>}
                                       </div>
                                   </div>
                               ))}
                           </div>
                           
                           <button onClick={addStep} className="mt-8 py-3 px-6 rounded-xl border-2 border-dashed border-[#2a3942] text-sm font-bold text-neutral-400 hover:border-blue-500/50 hover:text-blue-400 transition-all w-full flex items-center justify-center gap-2"><Plus size={18}/> Add Step Trigger</button>
                       </div>
                   </div>
                   
                   <div className="mt-8 flex justify-end">
                       <button onClick={handleCreate} className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold py-4 px-12 rounded-xl shadow-[0_10px_20px_rgba(59,130,246,0.3)] transition-all hover:-translate-y-1 text-lg">Launch Campaign Queue</button>
                   </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex-1 flex flex-col bg-[#111b21] relative ${(activeCall && activeTab !== 'campaigns') ? 'pt-[88px]' : ''}">
            <div className="h-20 border-b border-[#222d34] flex items-center px-10 bg-[#111b21] shrink-0 sticky top-0 z-20 justify-between">
               <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-400 to-indigo-500 bg-clip-text text-transparent flex items-center gap-3"><Component size={28} className="text-purple-400" /> Active Sequences</h1>
               <button onClick={()=>setIsCreating(true)} className="bg-purple-600 hover:bg-purple-500 text-white font-bold py-2.5 px-6 rounded-xl shadow-lg flex items-center gap-2 text-sm"><Plus size={16}/> Build Sequence</button>
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto max-w-6xl mx-auto w-full">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {campaigns.map(c => {
                        const pools = c.sender_pool ? JSON.parse(c.sender_pool) : [];
                        return (
                            <div key={c.id} className="bg-[#202c33] border border-[#2a3942] rounded-2xl p-6 shadow-xl relative overflow-hidden group hover:border-[#33454f] transition-colors">
                                <div className={`absolute top-0 left-0 w-1.5 h-full ${c.status === 'active' ? 'bg-emerald-500' : 'bg-neutral-600'}`}></div>
                                <div className="flex justify-between items-start mb-4 pl-2">
                                    <div>
                                        <h3 className="font-bold text-xl text-neutral-100 mb-1">{c.name}</h3>
                                        <p className="text-[10px] uppercase font-bold tracking-widest text-emerald-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> {c.status} Sequence</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="text-xs text-neutral-500 font-mono">{new Date(c.created_at).toLocaleDateString()}</p>
                                    </div>
                                </div>
                                <div className="pl-2 flex gap-4 mt-8 pt-4 border-t border-[#2a3942]/60">
                                   <div className="flex-1">
                                       <span className="block text-[10px] font-bold text-neutral-500 tracking-widest uppercase mb-1">Target Target</span>
                                       <p className="text-sm font-medium text-blue-300">List ID: {c.list_id}</p>
                                   </div>
                                   <div className="flex-1">
                                       <span className="block text-[10px] font-bold text-neutral-500 tracking-widest uppercase mb-1">Numbers Used</span>
                                       <div className="flex gap-1 flex-wrap">
                                           {pools.map(p=><span key={p} className="text-[10px] bg-[#111b21] border border-[#2a3942] px-2 py-0.5 rounded text-neutral-400">{p}</span>)}
                                       </div>
                                   </div>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    );
};

// ==============================================================
// 4. ADMIN TAB
// ==============================================================
const AdminTab = () => {
    const [users, setUsers] = useState([]);
    const [assignTarget, setAssignTarget] = useState(null);
    const [assignNum, setAssignNum] = useState('');
    const [showInvite, setShowInvite] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [invitePass, setInvitePass] = useState('');
    const [inviteStatus, setInviteStatus] = useState('');

    const fetchUsers = () => {
        authFetch(`${API_BASE}/admin/users`).then(r=>r.json()).then(data => {
            if (!data.error) setUsers(data);
        }).catch(()=>{});
    };

    useEffect(() => { fetchUsers(); }, []);

    const handleAssign = async () => {
        if (!assignTarget || !assignNum) return;
        await authFetch(`${API_BASE}/admin/assign-number`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target_user_id: assignTarget, phone_number: assignNum })
        });
        setAssignTarget(null); setAssignNum(''); fetchUsers();
    };

    const handleInvite = async () => {
        if (!inviteEmail || !invitePass) return;
        setInviteStatus('Inviting...');
        const r = await authFetch(`${API_BASE}/admin/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: inviteEmail, password: invitePass })
        });
        const res = await r.json();
        if (res.success) {
            setShowInvite(false); setInviteEmail(''); setInvitePass(''); fetchUsers();
        } else {
            setInviteStatus(res.error || 'Failed');
        }
    };

    return (
        <div className="flex-1 overflow-y-auto p-4 md:p-10 bg-[#0b141a] space-y-6 relative">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                <h1 className="text-2xl md:text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-500">Admin Dashboard</h1>
                <button onClick={()=>setShowInvite(true)} className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white px-5 py-2.5 rounded-lg font-bold shadow-[0_0_20px_rgba(147,51,234,0.4)] transition flex items-center gap-2 self-start sm:self-auto active:scale-95">
                    <User size={16} /> Invite Agent
                </button>
            </div>
            
            <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-4 md:p-6 shadow-xl">
                <h2 className="text-lg font-bold text-neutral-100 mb-4 flex items-center gap-2"><User className="text-purple-400" size={18}/> Authorized Agents</h2>
                <div className="space-y-3">
                    {users.map(u => (
                        <div key={u.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 bg-[#0b141a] p-4 rounded-xl border border-[#222d34] hover:border-purple-500/30 transition">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <p className="font-bold text-neutral-200 text-sm truncate">{u.email}</p>
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0 ${u.role==='admin' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>{u.role}</span>
                                </div>
                                <p className="text-[10px] text-neutral-600 mt-1 font-mono truncate">{u.id}</p>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {(u.user_phone_numbers || []).map(p => <span key={p.phone_number} className="bg-[#111b21] px-2 py-0.5 rounded border border-[#222d34] text-xs font-mono text-emerald-400">{p.phone_number}</span>)}
                                    {(u.user_phone_numbers && u.user_phone_numbers.length === 0) && <span className="text-neutral-600 italic text-xs">No number assigned</span>}
                                </div>
                            </div>
                            <button onClick={() => setAssignTarget(u.id)} className="px-4 py-2 bg-[#202c33] hover:bg-purple-600 transition rounded-lg text-sm text-neutral-200 font-medium whitespace-nowrap active:scale-95 self-start sm:self-auto">Assign Number</button>
                        </div>
                    ))}
                </div>
            </div>

            {/* Assign Number Modal */}
            {assignTarget && (
                <div className="fixed inset-0 z-50 bg-black/70 flex items-end sm:items-center justify-center p-4 backdrop-blur-md">
                    <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <h2 className="text-lg font-bold text-white mb-4">Assign Twilio Number</h2>
                        <input value={assignNum} onChange={e=>setAssignNum(e.target.value)} placeholder="+1408..." className="w-full bg-[#0b141a] rounded-lg p-4 outline-none text-white focus:ring-2 focus:ring-purple-500 mb-5 border border-[#222d34] font-mono" />
                        <div className="flex justify-end gap-3">
                            <button onClick={()=>setAssignTarget(null)} className="px-5 py-2 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition">Cancel</button>
                            <button onClick={handleAssign} className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-2 rounded-lg font-bold shadow-[0_0_15px_rgba(147,51,234,0.3)] transition active:scale-95">Assign</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Invite Agent Modal */}
            {showInvite && (
                <div className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-4 backdrop-blur-md">
                    <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-6 w-full max-w-md shadow-2xl relative overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-500 to-blue-500"></div>
                        <h2 className="text-xl font-black text-white mb-5 flex items-center gap-2"><User className="text-purple-400" size={20}/> Create Agent</h2>
                        <div className="space-y-4 mb-6">
                            <div>
                                <label className="text-xs text-neutral-400 font-bold uppercase tracking-wider block mb-2">Agent Email</label>
                                <input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="agent@company.com" className="w-full bg-[#0b141a] rounded-lg p-3 outline-none text-white focus:ring-2 focus:ring-purple-500 border border-[#222d34]" />
                            </div>
                            <div>
                                <label className="text-xs text-neutral-400 font-bold uppercase tracking-wider block mb-2">Temporary Password</label>
                                <input type="password" value={invitePass} onChange={e=>setInvitePass(e.target.value)} placeholder="Minimum 6 characters" className="w-full bg-[#0b141a] rounded-lg p-3 outline-none text-white focus:ring-2 focus:ring-purple-500 border border-[#222d34]" />
                            </div>
                        </div>
                        {inviteStatus && <p className="text-rose-400 text-sm mb-4 font-bold">{inviteStatus}</p>}
                        <div className="flex justify-end gap-3 pt-4 border-t border-[#222d34]">
                            <button onClick={()=>setShowInvite(false)} className="px-5 py-2.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition font-medium">Cancel</button>
                            <button onClick={handleInvite} className="bg-white text-black px-6 py-2.5 rounded-lg font-black hover:bg-neutral-200 transition active:scale-95">Spawn Agent</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
