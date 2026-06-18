import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useOutletContext, Link } from 'react-router-dom';
import { api, COMPETITION_TYPES, normalizeSearchResults } from '../api.js';

const COMP_LABELS = {
  forkeppni: 'forkeppni',
  'a-urslit': 'a-úrslit',
  'b-urslit': 'b-úrslit',
};
const COMP_ID_BY_TYPE = { forkeppni: 1, 'a-urslit': 2, 'b-urslit': 3 };

export default function SlotPage() {
  const { slot } = useParams();
  const { events, reloadEvents } = useOutletContext();

  const slotNum = Number.parseInt(slot, 10);
  const ev = useMemo(
    () => events.find((e, idx) => (e.slot ?? idx + 1) === slotNum),
    [events, slotNum],
  );
  const eventId = ev?.eventId;

  const [state, setState] = useState(null);
  const [tests, setTests] = useState([]);
  const [gate, setGate] = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [manualClassId, setManualClassId] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [swapOptions, setSwapOptions] = useState([]);
  const [swapSelected, setSwapSelected] = useState('');
  const [swapCountry, setSwapCountry] = useState('IS');

  // Default the swap dropdown to the current source event
  useEffect(() => {
    const sourceId = ev?.sourceEventId ?? ev?.eventId;
    if (sourceId) setSwapSelected(String(sourceId));
  }, [ev?.sourceEventId, ev?.eventId]);

  const loadState = useCallback(() => {
    if (!eventId) return;
    api
      .getEventState(eventId)
      .then(setState)
      .catch(() => setState(null));
  }, [eventId]);

  useEffect(() => {
    setLabelInput(ev?.label || '');
  }, [ev?.label, eventId]);

  useEffect(() => {
    if (!eventId) return;
    // For the tests/gate calls, use the source event (real Sportfengur ID)
    // since synthetic slot keys don't exist on Sportfengur.
    const sourceId = ev?.sourceEventId ?? eventId;
    loadState();
    api
      .getTests(sourceId)
      .then((d) => setTests(Array.isArray(d?.res) ? d.res : []))
      .catch(() => setTests([]));
    api
      .getGate(eventId)
      .then((g) =>
        setGate(g?.allowedClassId == null ? '' : String(g.allowedClassId)),
      )
      .catch(() => {});
    const id = setInterval(loadState, 6000);
    return () => clearInterval(id);
  }, [eventId, loadState]);

  const classOptions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const t of tests) {
      const cid = Number.parseInt(String(t?.flokkar_numer), 10);
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const name = t?.flokkur_nafn || '';
      const grein = t?.keppnisgrein || '';
      out.push({
        classId: cid,
        label: `${cid}${name ? ' — ' + name : ''}${grein ? ' (' + grein + ')' : ''}`,
      });
    }
    return out;
  }, [tests]);

  // Load event search options for the swap dropdown (must be before early return)
  useEffect(() => {
    const year = new Date().getFullYear();
    api
      .searchEvents(year, swapCountry)
      .then((data) => setSwapOptions(normalizeSearchResults(data)))
      .catch(() => setSwapOptions([]));
  }, [swapCountry]);

  if (!ev) {
    return (
      <div className="card empty">
        Ekkert mót á slot {slot}. <Link to="/">Fara í yfirlit</Link>
      </div>
    );
  }

  const displayName = ev.label || ev.name || `Mót ${eventId}`;

  async function saveLabel() {
    setBusy(true);
    try {
      await api.setLabel(eventId, labelInput.trim());
      reloadEvents();
      setResult({ kind: 'ok', text: 'Nafn vistað.' });
    } catch (e) {
      setResult({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function swapEvent() {
    const newEventId = Number.parseInt(String(swapSelected), 10);
    if (!Number.isInteger(newEventId) || newEventId <= 0) {
      setResult({ kind: 'warn', text: 'Veldu mót til að skipta yfir á.' });
      return;
    }
    const opt = swapOptions.find((o) => o.eventId === newEventId);
    setBusy(true);
    try {
      await api.replaceEvent(eventId, newEventId, opt?.name || '');
      setResult({ kind: 'ok', text: 'Mót skipt!' });
      reloadEvents();
    } catch (e) {
      setResult({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function saveGate() {
    setBusy(true);
    try {
      const classId = gate === '' ? null : Number(gate);
      await api.setGate(eventId, classId);
      setResult({
        kind: 'ok',
        text: classId
          ? `Gate sett: aðeins classId ${classId}`
          : 'Gate aftengt: öll classId leyfð',
      });
    } catch (e) {
      setResult({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  async function doRefresh(type) {
    setBusy(true);
    setResult({ kind: 'ok', text: `Uppfæri ${COMP_LABELS[type]}...` });
    try {
      const cid = manualClassId.trim()
        ? Number(manualClassId.trim())
        : undefined;
      const data = await api.refresh(eventId, type, cid);
      setResult({ kind: 'ok', text: JSON.stringify(data, null, 2) });
      loadState();
      // Reload class options for the gate dropdown
      const sourceId = ev?.sourceEventId ?? eventId;
      api
        .getTests(sourceId)
        .then((d) => setTests(Array.isArray(d?.res) ? d.res : []))
        .catch(() => {});
    } catch (e) {
      setResult({ kind: 'warn', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  const comps = state?.competitions || {};
  const totalRows = COMPETITION_TYPES.reduce((sum, type) => {
    const c =
      comps[COMP_ID_BY_TYPE[type]] ||
      comps[String(COMP_ID_BY_TYPE[type])] ||
      {};
    return sum + (c.leaderboardCount ?? 0);
  }, 0);
  const isLive = totalRows > 0;
  const apiBase = window.location.origin;
  const shortcuts = [];
  for (const type of COMPETITION_TYPES) {
    shortcuts.push({
      label: `event/${slotNum}/${type}`,
      path: `/event/${slotNum}/${type}`,
    });
    shortcuts.push({
      label: `event/${slotNum}/${type}/csv`,
      path: `/event/${slotNum}/${type}/csv`,
    });
  }
  shortcuts.push({
    label: `event/${slotNum}/leaderboards.zip`,
    path: `/event/${slotNum}/leaderboards.zip`,
  });
  shortcuts.push({
    label: `event/${slotNum}/state`,
    path: `/event/${slotNum}/state`,
  });

  return (
    <>
      <div className="card">
        <div className="slot-head">
          <span className="slot-num">Slot {slotNum}</span>
          <span className={`badge ${isLive ? 'live' : 'idle'}`}>
            <span className="dot" />
            {isLive ? 'Með gögn' : 'Tómt'}
          </span>
        </div>
        <h2 style={{ marginTop: 6 }}>{displayName}</h2>
        <div className="slot-meta">eventId {eventId}</div>

        <label>Nafn á slot (t.d. bílnúmer)</label>
        <div className="row">
          <input
            className="grow"
            value={labelInput}
            placeholder="T.d. Bíll 1"
            onChange={(e) => setLabelInput(e.target.value)}
          />
          <button className="secondary" onClick={saveLabel} disabled={busy}>
            Vista nafn
          </button>
        </div>

        <label style={{ marginTop: 12 }}>Skipta um mót á þessu sloti</label>
        <div className="row">
          <select
            style={{ width: 100 }}
            value={swapCountry}
            onChange={(e) => setSwapCountry(e.target.value)}
          >
            <option value="IS">IS</option>
            <option value="SE">SE</option>
            <option value="DK">DK</option>
            <option value="NO">NO</option>
            <option value="">Öll</option>
          </select>
          {swapOptions.length > 0 ? (
            <select
              className="grow"
              value={swapSelected}
              onChange={(e) => setSwapSelected(e.target.value)}
            >
              <option value="">Veldu nýtt mót...</option>
              {/* Ensure the current event is always in the list */}
              {(ev?.sourceEventId ?? ev?.eventId) &&
                !swapOptions.some(
                  (o) => o.eventId === (ev?.sourceEventId ?? ev?.eventId),
                ) && (
                  <option value={ev?.sourceEventId ?? ev?.eventId}>
                    {ev?.sourceEventId ?? ev?.eventId} -{' '}
                    {ev?.name || 'Núverandi mót'}
                  </option>
                )}
              {swapOptions.map((o) => (
                <option key={o.eventId} value={o.eventId}>
                  {o.eventId} - {o.name}
                  {o.startsAt ? ` (${o.startsAt})` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="grow"
              type="number"
              placeholder="Sláðu inn eventId handvirkt..."
              value={swapSelected}
              onChange={(e) => setSwapSelected(e.target.value)}
            />
          )}
          <button className="secondary" onClick={swapEvent} disabled={busy}>
            Skipta
          </button>
        </div>
      </div>

      <div className="card">
        <h3>classId og gögn</h3>
        <div className="comp-grid">
          {COMPETITION_TYPES.map((type) => {
            const cid = COMP_ID_BY_TYPE[type];
            const c = comps[cid] || comps[String(cid)] || {};
            return (
              <div className="comp-box" key={type}>
                <div className="comp-label">{COMP_LABELS[type]}</div>
                {c.classId ? (
                  <div className="comp-val">{c.classId}</div>
                ) : (
                  <div className="comp-val missing">ekki sett</div>
                )}
                <div className="comp-count">
                  {c.leaderboardCount ?? 0} færslur
                </div>
              </div>
            );
          })}
        </div>

        <label style={{ marginTop: 12 }}>
          ClassId gating (aðeins þetta classId uppfærir gögn)
        </label>
        <div className="row">
          <select
            className="grow"
            value={gate}
            onChange={(e) => setGate(e.target.value)}
          >
            <option value="">Allt leyft (ekkert gate)</option>
            {classOptions.map((o) => (
              <option key={o.classId} value={o.classId}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="secondary" onClick={saveGate} disabled={busy}>
            Setja gate
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Handvirk uppfærsla</h3>
        <label>ClassId (valfrjálst handvirkt)</label>
        <input
          type="number"
          value={manualClassId}
          placeholder="T.d. 203060"
          onChange={(e) => setManualClassId(e.target.value)}
        />
        <div className="three" style={{ marginTop: 10 }}>
          {COMPETITION_TYPES.map((type) => (
            <button
              key={type}
              className="primary"
              onClick={() => doRefresh(type)}
              disabled={busy}
            >
              Uppfæra {COMP_LABELS[type]}
            </button>
          ))}
        </div>
        {result && (
          <>
            <label style={{ marginTop: 12 }}>Niðurstaða</label>
            <pre className={result.kind === 'warn' ? 'warn' : ''}>
              {result.text}
            </pre>
          </>
        )}
      </div>

      <div className="card">
        <h3>Flýtileiðir (vMix slóðir)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Bættu við <code>?sort=rank</code> fyrir röðun eftir einkunn.
        </p>
        <div className="endpoint-grid">
          {shortcuts.map((s) => (
            <button
              key={s.path}
              type="button"
              className="endpoint-btn"
              onClick={() =>
                window.open(apiBase + s.path, '_blank', 'noopener')
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
