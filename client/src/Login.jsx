import { useState } from 'react';
import { supabase } from './supabaseClient';
import './App.css'; // inherit styling

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setErrorMsg('');
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) setErrorMsg(error.message);
    setLoading(false);
  };

  return (
    <div className="flex flex-col items-center justify-center min-vh-100 bg-dark text-light p-4">
      <div className="card bg-darker p-5 rounded shadow" style={{ maxWidth: '400px', width: '100%' }}>
        <h2 className="mb-4 text-center">🏢 Login to Workspace</h2>
        {errorMsg && <div className="alert custom-alert-danger mb-3">{errorMsg}</div>}
        <form onSubmit={handleLogin}>
          <div className="mb-3">
            <label className="form-label">Email</label>
            <input 
              type="email" 
              className="form-control custom-input" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              required 
            />
          </div>
          <div className="mb-4">
            <label className="form-label">Password</label>
            <input 
              type="password" 
              className="form-control custom-input" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              required 
            />
          </div>
          <button type="submit" className="custom-btn primary w-100" disabled={loading}>
            {loading ? 'Logging in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
