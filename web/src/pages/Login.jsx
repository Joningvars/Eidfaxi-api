import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // If already logged in, bounce to the right place.
  useEffect(() => {
    api
      .me()
      .then((data) => {
        if (data?.authenticated) {
          navigate(data.role === 'slot' ? `/slot/${data.slot}` : '/', {
            replace: true,
          });
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api.login(username.trim(), password);
      const target = data.role === 'slot' ? `/slot/${data.slot}` : '/';
      navigate(target, { replace: true });
    } catch (err) {
      setError(err.message || 'Rangt notandanafn eða lykilorð.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/app/eidfaxi-logo.png" alt="EiðfaxiTV" />
          <div className="login-brand-name">
            Eiðfaxi<span className="tv">TV</span>
          </div>
        </div>
        <p className="login-sub">Skráðu þig inn til að opna stjórnborðið.</p>

        <label>Notandanafn</label>
        <input
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
          required
        />

        <label>Lykilorð</label>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        <button className="primary login-btn" type="submit" disabled={busy}>
          {busy ? 'Skrái inn...' : 'Innskráning'}
        </button>

        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}
