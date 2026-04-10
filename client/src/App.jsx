import React, { useState, useEffect, useRef } from 'react';
import { Phone, Send, User, MessageCircle, Mic, PhoneOff, PhoneCall, Zap, Users, Component, Plus, UploadCloud, CheckCircle, AlertTriangle, Trash2, LogOut } from 'lucide-react';
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
    <div className="flex h-screen bg-[#0b141a] text-white font-sans overflow-hidden">
      {/* GLOBAL CALL BANNER OVERLAY */}
      {activeCall && (
        <div className="absolute top-0 left-0 right-0 z-50 bg-emerald-900/95 backdrop-blur border-b border-emerald-500 p-4 px-6 flex justify-between items-center shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
          <div className="flex items-center gap-4">
            <div className="animate-pulse bg-emerald-500 p-3 rounded-full"><Mic size={22} className="text-white" /></div>
            <div>
              <h3 className="text-emerald-50 text-lg font-bold tracking-wide">{callStatus === 'incoming' ? 'Incoming Call...' : 'Active Call'}</h3>
              <p className="text-sm text-emerald-300 font-mono">{activeCall.customParameters?.get('From') || 'Direct Connection'}</p>
            </div>
          </div>
          <div className="flex gap-3">
            {callStatus === 'incoming' && (
              <button onClick={acceptCall} className="bg-green-500 hover:bg-green-400 text-green-950 px-8 py-3 rounded-full font-extrabold flex items-center gap-2 transition-transform hover:scale-105">
                <Phone size={20} className="fill-current" /> Answer
              </button>
            )}
            <button onClick={endCall} className="bg-rose-600 hover:bg-rose-500 text-white px-8 py-3 rounded-full font-bold flex items-center gap-2 transition-transform hover:scale-105">
              <PhoneOff size={20} /> {callStatus === 'incoming' ? 'Decline' : 'End Call'}
            </button>
          </div>
        </div>
      )}

      {/* Main Global Sidebar */}
      <div className="w-20 bg-[#111b21] flex flex-col items-center py-6 gap-8 border-r border-[#222d34] flex-shrink-0 z-40">
        <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-3 rounded-xl shadow-lg shadow-blue-500/20">
          <Zap className="text-white" size={24} />
        </div>
        
        <nav className="flex flex-col gap-4 w-full pt-4">
          <button onClick={() => setActiveTab('inbox')} title="Inbox" className={`flex justify-center p-3 w-full border-l-2 transition-all group ${activeTab==='inbox'?'border-blue-500 text-blue-400 bg-blue-500/5':'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
            <MessageCircle size={26} className="group-hover:scale-110 transition-transform" />
          </button>
          <button onClick={() => setActiveTab('leads')} title="Contacts & Leads" className={`flex justify-center p-3 w-full border-l-2 transition-all group ${activeTab==='leads'?'border-blue-500 text-blue-400 bg-blue-500/5':'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
            <Users size={26} className="group-hover:scale-110 transition-transform" />
          </button>
          <button onClick={() => setActiveTab('campaigns')} title="Campaigns" className={`flex justify-center p-3 w-full border-l-2 transition-all group ${activeTab==='campaigns'?'border-blue-500 text-blue-400 bg-blue-500/5':'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
            <Component size={26} className="group-hover:scale-110 transition-transform" />
          </button>
          {role === 'admin' && (
            <button onClick={() => setActiveTab('admin')} title="Admin & Security" className={`flex justify-center p-3 w-full border-l-2 transition-all group ${activeTab==='admin'?'border-purple-500 text-purple-400 bg-purple-500/5':'border-transparent text-neutral-500 hover:text-neutral-300'}`}>
              <User size={26} className="group-hover:scale-110 transition-transform" />
            </button>
          )}
        </nav>

        {/* Logout at the very bottom */}
        <button
          onClick={() => supabase.auth.signOut()}
          title="Log Out"
          className="mt-auto flex justify-center p-3 w-full border-l-2 border-transparent text-neutral-600 hover:text-rose-400 hover:border-rose-500 transition-all group"
        >
          <LogOut size={22} className="group-hover:scale-110 transition-transform" />
        </button>
      </div>

      {/* RENDER ACTIVE TAB COMPONENT */}
      <div className={`flex-1 flex overflow-hidden ${(activeCall && activeTab !== 'campaigns') ? 'pt-[88px]' : ''}`}>
        {activeTab === 'inbox' && <InboxTab senders={senders} callStatus={callStatus} makeCall={makeCall} />}
        {activeTab === 'admin' && role === 'admin' && <AdminTab />}
        {activeTab === 'leads' && <LeadsTab />}
        {activeTab === 'campaigns' && <CampaignsTab senders={senders} />}
      </div>
    </div>
  );
}


// ==============================================================
// 1. INBOX TAB
// ==============================================================
const InboxTab = ({ senders, callStatus, makeCall }) => {
  const [contacts, setContacts] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [overrideSender, setOverrideSender] = useState(''); // sticky override
  const [showOverrideWarning, setShowOverrideWarning] = useState(false);
  const [newNumberDial, setNewNumberDial] = useState('');
  const [showDialer, setShowDialer] = useState(false);
  const messagesEndRef = useRef(null);

  useEffect(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);

  const loadData = () => {
    authFetch(`${API_BASE}/contacts`).then(r => r.json()).then(data => !data.error && setContacts(data)).catch(()=>{});
    if (selectedContact?.id && selectedContact.id !== 'temp') {
      authFetch(`${API_BASE}/contacts/${selectedContact.id}/messages`).then(r => r.json()).then(data => !data.error && setMessages(data)).catch(()=>{});
    }
  };

  useEffect(() => { loadData(); const i = setInterval(loadData, 2000); return () => clearInterval(i); }, [selectedContact]);

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
    
    setMessages(prev => [...prev, { id: Date.now(), direction: 'outbound', content: payload.content, created_at: new Date().toISOString() }]);

    const res = await authFetch(`${API_BASE}/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const json = await res.json();
    if (json.error) {
       alert("Failed to send message: " + json.error);
       // Remove optimistic message on failure
       setMessages(prev => prev.filter(m => m.id !== Date.now()));
    }
    loadData();
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
          loadData();
      }
  };

  return (
    <>
      <div className="w-80 bg-[#111b21] border-r border-[#222d34] flex flex-col relative z-20">
        <div className="p-4 border-b border-[#222d34] flex justify-between items-center">
          <h1 className="text-lg font-bold text-neutral-100 flex items-center gap-2"><MessageCircle size={20} className="text-blue-500"/> Inbox</h1>
          <button onClick={() => setShowDialer(!showDialer)} className="bg-neutral-800 hover:bg-neutral-700 text-neutral-300 p-2 rounded-full transition shadow h-8 w-8 flex items-center justify-center"><Plus size={16} /></button>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {contacts.map(c => (
            <div key={c.id} onClick={() => selectContact(c)} className={`p-4 border-b border-[#2a3942]/40 cursor-pointer hover:bg-[#202c33] transition ${selectedContact?.id === c.id ? 'bg-[#2a3942] border-l-4 border-l-blue-500' : ''}`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-neutral-800 rounded-full flex items-center justify-center flex-shrink-0 text-neutral-400"><User size={20} /></div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <h3 className="font-medium text-neutral-200 truncate">{c.name || c.phone_number}</h3>
                    <span className="text-[10px] text-neutral-500">{new Date(c.updated_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                  </div>
                  <p className="text-xs text-neutral-400 truncate">{c.last_message}</p>
                </div>
              </div>
            </div>
          ))}
          {contacts.length === 0 && <div className="p-8 text-center text-neutral-600 text-sm">No active conversions.</div>}
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

      <div className="flex-1 flex flex-col bg-[#0b141a] relative bg-[url('https://www.transparenttextures.com/patterns/cartographer.png')] bg-blend-overlay">
        {selectedContact ? (
          <>
            <div className={`bg-[#202c33] p-4 px-6 border-b border-[#2a3942] flex justify-between items-center z-10 shadow-sm`}>
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-neutral-800 text-neutral-400 rounded-full flex items-center justify-center text-xl"><User size={24} /></div>
                <div>
                  <h2 className="text-lg font-bold text-neutral-50">{selectedContact.name || selectedContact.phone_number}</h2>
                  <div className="flex items-center gap-2 mt-0.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_5px_#10b981]"></span>
                      <p className="text-[10px] font-medium text-neutral-400 capitalize tracking-wide">
                        {selectedContact.assigned_sender_number ? `Locked to ${selectedContact.assigned_sender_number}` : 'No Sticky Assigned'}
                      </p>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                 <button onClick={() => handleDelete(selectedContact.id)} disabled={selectedContact.id === 'temp'} className="p-2.5 rounded-full flex items-center justify-center transition shadow-md bg-rose-600/20 hover:bg-rose-500 text-rose-500 hover:text-white disabled:opacity-50">
                    <Trash2 size={16} />
                 </button>
                 <button onClick={() => makeCall(selectedContact.phone_number)} disabled={callStatus !== 'ready'} className={`p-2.5 px-6 rounded-full flex items-center gap-2 transition font-medium shadow-md ${callStatus === 'ready' ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-neutral-800 text-neutral-600 cursor-not-allowed'}`}>
                   <Phone size={16} className="fill-current opacity-80" /> <span className="text-sm">{callStatus === 'initializing' ? 'Connecting...' : 'Call'}</span>
                 </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 relative z-10">
              {messages.map(msg => {
                const isOut = msg.direction === 'outbound';
                return (
                  <div key={msg.id} className={`flex relative z-10 ${isOut ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-xl px-4 py-2.5 shadow text-[14.5px] leading-relaxed ${isOut ? 'bg-[#005c4b] text-[#e9edef] rounded-tr-none' : 'bg-[#202c33] text-[#e9edef] rounded-tl-none'}`}>
                      {msg.type === 'call' && (
                         <div className="mb-2 p-2 bg-[#111b21]/50 rounded-lg border border-neutral-700/50 flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-blue-400 font-bold text-xs"><PhoneCall size={14} /> {msg.direction === 'inbound' ? 'Incoming' : 'Outgoing'} Call</div>
                            {msg.recording_url && <audio controls controlsList="nodownload" src={`${API_BASE}/recordings?url=${encodeURIComponent(msg.recording_url)}`} className="h-8 max-w-[200px]" />}
                         </div>
                      )}
                      {msg.type !== 'call' && <p className="whitespace-pre-wrap">{msg.content}</p>}
                      {msg.type === 'call' && !msg.recording_url && <p className="whitespace-pre-wrap italic opacity-80">{msg.content}</p>}
                      <div className="flex justify-end items-center mt-1 opacity-60">
                         <span className="text-[9px] uppercase">{new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} className="h-4" />
            </div>

            <div className="p-4 px-6 bg-[#202c33] border-t border-[#2a3942] z-10 flex flex-col gap-2">
              {showOverrideWarning && (
                  <div className="bg-rose-900/30 border border-rose-500/50 p-3 rounded-xl flex items-center justify-between shadow-lg mb-2 animate-in fade-in slide-in-from-bottom-2">
                     <div className="flex items-center gap-3">
                         <AlertTriangle className="text-rose-400" size={20} />
                         <div>
                             <p className="text-sm font-semibold text-rose-100">Sticky Override Warning!</p>
                             <p className="text-xs text-rose-300">You are changing the "From" number from this lead's permanently assigned sender. Changing this will break thread continuity.</p>
                         </div>
                     </div>
                     <div className="flex gap-2">
                        <button onClick={() => setShowOverrideWarning(false)} className="text-xs bg-neutral-800 hover:bg-neutral-700 px-3 py-1.5 rounded-lg text-white">Cancel</button>
                        <button onClick={handleSend} className="text-xs bg-rose-600 hover:bg-rose-500 px-3 py-1.5 rounded-lg text-white font-semibold">Yes, Override</button>
                     </div>
                  </div>
              )}
              
              <div className="flex justify-between items-center px-1 mb-1">
                 <p className="text-xs text-neutral-500 tracking-wide font-semibold uppercase">Reply using channel:</p>
                 <select 
                    value={overrideSender || selectedContact.assigned_sender_number || senders[0]?.phone_number} 
                    onChange={e => setOverrideSender(e.target.value)}
                    className="bg-[#2a3942] text-xs text-blue-300 px-3 py-1 rounded outline-none border border-[#111b21]"
                 >
                    {senders.map(s => <option key={s.id} value={s.phone_number}>{s.name || s.phone_number}</option>)}
                 </select>
              </div>
              <form onSubmit={handleSend} className="max-w-5xl w-full mx-auto flex gap-3">
                <input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} placeholder="Type a message..." className="flex-1 bg-[#2a3942] border border-[#111b21] rounded-xl px-5 py-3.5 text-white focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition placeholder:text-neutral-500" />
                <button type="submit" disabled={!messageInput.trim()} className="bg-emerald-600 disabled:bg-neutral-800 disabled:text-neutral-600 text-white w-14 rounded-xl flex items-center justify-center transition-all shadow hover:bg-emerald-500 group"><Send size={20} className="ml-1 group-disabled:opacity-50" /></button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center flex-col text-neutral-600 p-8 z-10 backdrop-blur-sm">
             <MessageCircle size={56} className="text-neutral-800 drop-shadow-md mb-4" strokeWidth={1} />
             <p className="max-w-xs text-center text-sm font-medium">Select a chat to view sticky threads or start a fresh connection.</p>
          </div>
        )}
      </div>
    </>
  );
};


// ==============================================================
// 2. LEADS TAB (CSV Uploads)
// ==============================================================
const LeadsTab = () => {
    const [lists, setLists] = useState([]);
    const [file, setFile] = useState(null);
    const [listName, setListName] = useState('');
    const [uploading, setUploading] = useState(false);

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

    return (
        <div className="flex-1 flex flex-col bg-[#111b21] relative ${(activeCall && activeTab !== 'campaigns') ? 'pt-[88px]' : ''}">
            <div className="h-20 border-b border-[#222d34] flex items-center px-10 bg-[#111b21] shrink-0 sticky top-0 z-20">
               <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-teal-500 bg-clip-text text-transparent flex items-center gap-3"><Users size={28} className="text-emerald-400" /> Lead Storage</h1>
            </div>
            
            <div className="flex-1 p-10 overflow-y-auto max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-8">
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
                            <div key={list.id} className="bg-[#202c33] border border-[#2a3942] rounded-xl p-5 flex justify-between items-center shadow-md">
                                <div>
                                    <h3 className="font-bold text-neutral-100 text-lg mb-1">{list.name}</h3>
                                    <p className="text-xs text-neutral-500 font-mono tracking-wider">{new Date(list.created_at).toLocaleDateString()}</p>
                                </div>
                                <div className="bg-[#111b21] border border-[#2a3942] px-4 py-2 rounded-lg flex flex-col items-center justify-center">
                                    <span className="text-blue-400 font-bold text-lg">{list.lead_count || 0}</span>
                                    <span className="text-[9px] uppercase text-neutral-500 font-semibold tracking-widest">Leads</span>
                                </div>
                            </div>
                        ))}
                        {lists.length === 0 && <div className="text-neutral-600 text-sm text-center py-10 bg-[#202c33] rounded-xl border border-dashed border-[#2a3942]">No imported lead lists found. Upload a CSV to get started.</div>}
                    </div>
                </div>
            </div>
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
                                           <p className="text-[10px] text-emerald-400/80 mb-2 font-mono">Tip: Inject dynamic CSV fields like {'{{firstName}}'} or {'{{companyName}}'}</p>
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
        <div className="flex-1 overflow-y-auto p-10 bg-[#0b141a] space-y-8 relative">
            <div className="flex justify-between items-center">
                <h1 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-500">Admin Security & Dashboard</h1>
                <button onClick={()=>setShowInvite(true)} className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white px-6 py-2.5 rounded-lg font-bold shadow-[0_0_20px_rgba(147,51,234,0.4)] transition flex items-center gap-2">
                    <User size={18} /> Invite Agent
                </button>
            </div>
            
            <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-6 shadow-xl relative overflow-hidden">
                <h2 className="text-xl font-bold text-neutral-100 mb-6 flex items-center gap-2"><User className="text-purple-400"/> Authorized Agents</h2>
                <div className="space-y-4">
                    {users.map(u => (
                        <div key={u.id} className="flex justify-between items-center bg-[#0b141a] p-5 rounded-xl border border-[#222d34] hover:border-purple-500/30 transition">
                            <div>
                                <p className="font-bold text-neutral-200">{u.email} <span className={`text-[10px] ml-2 px-2 py-0.5 rounded-full uppercase tracking-wider ${u.role==='admin' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'}`}>{u.role}</span></p>
                                <p className="text-xs text-neutral-500 mt-1 font-mono">{u.id}</p>
                                <div className="mt-3 text-sm text-emerald-400 flex flex-wrap gap-2">
                                    {(u.user_phone_numbers || []).map(p => <span key={p.phone_number} className="bg-[#111b21] px-3 py-1 rounded-md border border-[#222d34] text-xs font-mono">{p.phone_number}</span>)}
                                    {(u.user_phone_numbers && u.user_phone_numbers.length === 0) && <span className="text-neutral-600 italic text-xs">No Twilio identity assigned</span>}
                                </div>
                            </div>
                            <button onClick={() => setAssignTarget(u.id)} className="px-5 py-2.5 bg-[#202c33] hover:bg-purple-600 transition tracking-wide hover:shadow-[0_0_20px_rgba(147,51,234,0.4)] rounded-lg text-sm text-neutral-200 font-medium whitespace-nowrap ml-4">Assign Number</button>
                        </div>
                    ))}
                </div>
            </div>

            {assignTarget && (
                <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-md">
                    <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <h2 className="text-xl font-bold text-white mb-4">Assign Twilio Number</h2>
                        <input value={assignNum} onChange={e=>setAssignNum(e.target.value)} placeholder="+1408..." className="w-full bg-[#0b141a] rounded-lg p-4 outline-none text-white focus:ring-2 focus:ring-purple-500 mb-6 border border-[#222d34] font-mono text-lg" />
                        <div className="flex justify-end gap-3">
                            <button onClick={()=>setAssignTarget(null)} className="px-5 py-2 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition">Cancel</button>
                            <button onClick={handleAssign} className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-2 rounded-lg font-bold shadow-[0_0_15px_rgba(147,51,234,0.3)] transition">Assign Identity</button>
                        </div>
                    </div>
                </div>
            )}

            {showInvite && (
                <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-md">
                    <div className="bg-[#111b21] border border-[#222d34] rounded-2xl p-8 w-full max-w-md shadow-2xl relative overflow-hidden">
                        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-purple-500 to-blue-500"></div>
                        <h2 className="text-2xl font-black text-white mb-6 flex items-center gap-2"><User className="text-purple-400" /> Secure Agent Creation</h2>
                        
                        <div className="space-y-4 mb-8">
                            <div>
                                <label className="text-xs text-neutral-400 font-bold uppercase tracking-wider block mb-2">Agent Email</label>
                                <input value={inviteEmail} onChange={e=>setInviteEmail(e.target.value)} placeholder="agent@company.com" className="w-full bg-[#0b141a] rounded-lg p-3 outline-none text-white focus:ring-2 focus:ring-purple-500 border border-[#222d34]" />
                            </div>
                            <div>
                                <label className="text-xs text-neutral-400 font-bold uppercase tracking-wider block mb-2">Temporary Password</label>
                                <input type="password" value={invitePass} onChange={e=>setInvitePass(e.target.value)} placeholder="Minimum 6 characters" className="w-full bg-[#0b141a] rounded-lg p-3 outline-none text-white focus:ring-2 focus:ring-purple-500 border border-[#222d34]" />
                            </div>
                        </div>

                        <p className="text-rose-400 text-sm mb-4 font-bold">{inviteStatus}</p>

                        <div className="flex justify-end gap-3 pt-4 border-t border-[#222d34]">
                            <button onClick={()=>setShowInvite(false)} className="px-5 py-2.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/5 transition font-medium">Cancel</button>
                            <button onClick={handleInvite} className="bg-white text-black px-6 py-2.5 rounded-lg font-black hover:bg-neutral-200 transition">Spawn Agent</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
