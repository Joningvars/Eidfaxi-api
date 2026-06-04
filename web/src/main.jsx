import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import Layout from './Layout.jsx';
import Overview from './pages/Overview.jsx';
import SlotPage from './pages/SlotPage.jsx';

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <Layout />,
      children: [
        { index: true, element: <Overview /> },
        { path: 'slot/:slot', element: <SlotPage /> },
      ],
    },
  ],
  { basename: '/app' },
);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
