// API client for the Eidfaxi control backend.
// All calls are same-origin (served by Express in prod, proxied in dev).

const COMPETITION_TYPES = ['forkeppni', 'a-urslit', 'b-urslit'];
const COMPETITION_ID_BY_TYPE = { forkeppni: 1, 'a-urslit': 2, 'b-urslit': 3 };

export { COMPETITION_TYPES, COMPETITION_ID_BY_TYPE };

async function json(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const message =
      (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.body = data;
    throw error;
  }
  return data;
}

const jsonHeaders = { 'Content-Type': 'application/json' };

export const api = {
  me: () => fetch('/control/me').then(json),

  login: (username, password) =>
    fetch('/control/login', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ username, password }),
    }).then(json),

  logout: () =>
    fetch('/control/logout', {
      method: 'POST',
      headers: jsonHeaders,
    })
      .then(json)
      .catch(() => {}),

  listEvents: () => fetch('/events').then(json),

  getEventState: (eventId) => fetch(`/event/${eventId}/state`).then(json),

  registerEvent: (eventId, name) =>
    fetch('/events/register', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ eventId, name }),
    }).then(json),

  removeEvent: (eventId) =>
    fetch(`/events/${eventId}`, {
      method: 'DELETE',
      headers: jsonHeaders,
    }).then(json),

  setLabel: (eventId, label) =>
    fetch(`/events/${eventId}/label`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ label }),
    }).then(json),

  replaceEvent: (eventId, newEventId, name) =>
    fetch(`/events/${eventId}/replace`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ eventId: newEventId, name }),
    }).then(json),

  getGate: (eventId) => fetch(`/events/${eventId}/gate`).then(json),

  setGate: (eventId, classId) =>
    fetch(`/events/${eventId}/gate`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ classId }),
    }).then(json),

  refresh: (eventId, competitionType, classId) =>
    fetch(`/event/${eventId}/${competitionType}/refresh`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(classId ? { classId } : {}),
    }).then(json),

  getTests: (eventId) => fetch(`/event/${eventId}/tests`).then(json),

  searchEvents: (year, country) => {
    const params = new URLSearchParams({ ar: String(year) });
    if (country) params.set('land', country);
    return fetch(`/events/search?${params.toString()}`).then(json);
  },

  webhookLog: () => fetch('/control/webhooks').then(json),
};

export function normalizeSearchResults(data) {
  const events = Array.isArray(data?.tournaments)
    ? data.tournaments
    : Array.isArray(data?.res)
      ? data.res
      : [];
  return events
    .map((item) => {
      const eventId = item.numer ?? item.mot_numer ?? item.eventId ?? item.id;
      const name = item.motsheiti ?? item.mot_heiti ?? item.name ?? 'Mót';
      const startsAt =
        item.byrjunardagsetning ??
        item.dagsetning_byrjar ??
        item.mot_byrjar ??
        '';
      return {
        eventId: Number.parseInt(String(eventId), 10),
        name: String(name || 'Mót'),
        startsAt: String(startsAt || ''),
      };
    })
    .filter((item) => Number.isInteger(item.eventId) && item.eventId > 0)
    .sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
}
