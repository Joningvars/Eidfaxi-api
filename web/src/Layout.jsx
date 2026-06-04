import { useEffect, useState, useCallback } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api.js';

export default function Layout() {
  const [events, setEvents] = useState([]);
  const [me, setMe] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  const load = useCallback(() => {
    api
      .listEvents()
      .then((data) => setEvents(Array.isArray(data?.events) ? data.events : []))
      .catch(() => {});
  }, []);

  // Resolve role once on mount. If unauthenticated, send to login.
  useEffect(() => {
    api
      .me()
      .then((data) => {
        setMe(data);
        // Slot users landing on the overview get redirected to their slot.
        if (data?.role === 'slot' && location.pathname === '/') {
          navigate(`/slot/${data.slot}`, { replace: true });
        }
      })
      .catch(() => {
        window.location.href = '/control/login';
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load, location.pathname]);

  const isAdmin = me?.role === 'admin';

  return (
    <div className="wrap">
      <div className="topbar">
        <h1>Eidfaxi Stjórnborð</h1>
        <nav className="nav">
          {isAdmin && (
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                'navlink' + (isActive ? ' active' : '')
              }
            >
              Yfirlit
            </NavLink>
          )}
          {events.map((ev, idx) => {
            const slot = ev.slot ?? idx + 1;
            const name = ev.label || ev.name || `Slot ${slot}`;
            return (
              <NavLink
                key={ev.eventId}
                to={`/slot/${slot}`}
                className={({ isActive }) =>
                  'navlink' + (isActive ? ' active' : '')
                }
              >
                {name}
              </NavLink>
            );
          })}
          <a className="navlink" href="/control/logout">
            Útskrá
          </a>
        </nav>
      </div>
      <Outlet context={{ events, reloadEvents: load, me, isAdmin }} />
    </div>
  );
}
