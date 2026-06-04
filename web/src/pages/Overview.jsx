import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { api, normalizeSearchResults } from '../api.js';

const COUNTRIES = [
  { code: 'IS', label: 'Ísland' },
  { code: 'SE', label: 'Svíþjóð' },
  { code: 'DK', label: 'Danmörk' },
  { code: 'NO', label: 'Noregur' },
  { code: 'FI', label: 'Finnland' },
  { code: 'DE', label: 'Þýskaland' },
  { code: '', label: 'Öll lönd' },
];

const COMP_LABELS = { 1: 'forkeppni', 2: 'a-úrslit', 3: 'b-úrslit' };

export default function Overview() {
  const { events, reloadEvents, isAdmin } = useOutletContext();
  const navigate = useNavigate();

  const [country, setCountry] = useState('IS');
  const [options, setOptions] = useState([]);
  const [selected, setSelected] = useState('');
  const [states, setStates] = useState({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const loadSearch = useCallback(() => {
    const year = new Date().getFullYear();
    api
      .searchEvents(year, country)
      .then((data) => setOptions(normalizeSearchResults(data)))
      .catch(() => setOptions([]));
  }, [country]);

  useEffect(() => {
    loadSearch();
  }, [loadSearch]);

  // Load per-event state for the data counts
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      events.map((ev) =>
        api
          .getEventState(ev.eventId)
          .then((s) => [ev.eventId, s])
          .catch(() => [ev.eventId, null]),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const map = {};
      for (const [id, s] of pairs) map[id] = s;
      setStates(map);
    });
    return () => {
      cancelled = true;
    };
  }, [events]);

  async function addEvent() {
    const eventId = Number.parseInt(String(selected), 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      setToast({ kind: 'warn', text: 'Veldu mót fyrst.' });
      return;
    }
    const opt = options.find((o) => o.eventId === eventId);
    setBusy(true);
    try {
      await api.registerEvent(eventId, opt?.name || '');
      setToast({ kind: 'ok', text: 'Móti bætt við.' });
      setSelected('');
      reloadEvents();
    } catch (e) {
      setToast({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(eventId) {
    if (!window.confirm(`Fjarlægja mót ${eventId}?`)) return;
    setBusy(true);
    try {
      await api.removeEvent(eventId);
      reloadEvents();
    } catch (e) {
      setToast({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  // Slot users are not allowed on the overview.
  if (isAdmin === false) {
    return (
      <div className="card empty">
        Þú hefur ekki aðgang að yfirliti. Notaðu þinn flipa hér að ofan.
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>Bæta við móti ({events.length}/10)</h2>
        <div className="row">
          <div style={{ width: 160 }}>
            <label>Land</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label>Veldu mót</label>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Veldu mót...</option>
              {options.map((o) => (
                <option key={o.eventId} value={o.eventId}>
                  {o.eventId} - {o.name}
                  {o.startsAt ? ` (${o.startsAt})` : ''}
                </option>
              ))}
            </select>
          </div>
          <button
            className="primary"
            onClick={addEvent}
            disabled={busy || events.length >= 10}
          >
            Bæta við
          </button>
        </div>
        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>

      <div className="card">
        <h2>Virk mót</h2>
        {events.length === 0 ? (
          <div className="empty">
            Engin virk mót. Bættu við móti hér að ofan.
          </div>
        ) : (
          <div className="slot-grid">
            {events.map((ev, idx) => {
              const slot = ev.slot ?? idx + 1;
              const state = states[ev.eventId];
              const comps = state?.competitions || {};
              return (
                <div className="slot-card" key={ev.eventId}>
                  <div className="slot-num">Slot {slot}</div>
                  <div className="slot-name">
                    {ev.label || ev.name || `Mót ${ev.eventId}`}
                  </div>
                  <div className="slot-meta">eventId: {ev.eventId}</div>
                  {(ev.loginUsername || ev.loginPassword) && (
                    <div className="statebox" style={{ fontSize: 12 }}>
                      <div>
                        Innskráning:&nbsp;
                        <span className="stateval">{ev.loginUsername}</span>
                      </div>
                      <div>
                        Lykilorð:&nbsp;
                        <span className="stateval">{ev.loginPassword}</span>
                      </div>
                    </div>
                  )}
                  <div className="comp-grid">
                    {[1, 2, 3].map((cid) => {
                      const c = comps[cid] || comps[String(cid)] || {};
                      const count = c.leaderboardCount ?? 0;
                      return (
                        <div className="comp-box" key={cid}>
                          <div className="comp-label">{COMP_LABELS[cid]}</div>
                          <div className="comp-count">{count} færslur</div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="ghost grow"
                      onClick={() => navigate(`/slot/${slot}`)}
                    >
                      Opna
                    </button>
                    <button
                      className="danger"
                      onClick={() => remove(ev.eventId)}
                      disabled={busy}
                    >
                      Fjarlægja
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
