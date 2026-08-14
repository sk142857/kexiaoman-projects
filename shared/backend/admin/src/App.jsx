import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import MonitorDashboard from './pages/MonitorDashboard.jsx';
import LearningDashboard from './pages/LearningDashboard.jsx';
import ManagePage from './pages/ManagePage.jsx';

// token 守卫（布局路由）：无 token 跳登录
function RequireAuth() {
  const token = localStorage.getItem('admin_token');
  return token ? <Outlet /> : <Navigate to="/login" replace />;
}

// 管理员专属仪表盘守卫：监控仪表盘仅 admin 可访问，学生直链访问跳转学习仪表盘
function RequireAdmin() {
  let role = '';
  try { role = (JSON.parse(localStorage.getItem('admin_user') || '{}').role) || ''; } catch (_) {}
  if (role === 'admin') return <Outlet />;
  return <Navigate to="/dashboard/learning" replace />;
}

// 首页重定向：管理员进监控仪表盘，其余进学习仪表盘
function HomeRedirect() {
  let role = '';
  try { role = (JSON.parse(localStorage.getItem('admin_user') || '{}').role) || ''; } catch (_) {}
  return <Navigate to={role === 'admin' ? '/dashboard/monitor' : '/dashboard/learning'} replace />;
}

export default function App() {
  return (
    <BrowserRouter basename="/admin">
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<Dashboard />}>
            <Route path="/" element={<HomeRedirect />} />
            <Route element={<RequireAdmin />}>
              <Route path="/dashboard/monitor" element={<MonitorDashboard />} />
            </Route>
            <Route path="/dashboard/learning" element={<LearningDashboard />} />
            <Route path="/module/:module" element={<ManagePage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
