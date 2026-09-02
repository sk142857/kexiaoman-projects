import React, { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ProLayout } from '@ant-design/pro-components';
import { Dropdown, message } from 'antd';
import { menuApi, auditApi, authApi } from '../services/api';
import {
  DashboardOutlined, LineChartOutlined, UserOutlined, HeartOutlined,
  EditOutlined, RiseOutlined, HistoryOutlined, ClockCircleOutlined,
  ApiOutlined, MobileOutlined, SafetyOutlined, LogoutOutlined,
  AppstoreOutlined, FundOutlined, SettingOutlined, MonitorOutlined,
  PictureOutlined, ThunderboltOutlined, BookOutlined, ReadOutlined,
  UnorderedListOutlined, CalendarOutlined, TeamOutlined, MenuOutlined,
  DatabaseOutlined, ProfileOutlined, OrderedListOutlined, FolderOutlined,
  AuditOutlined, CheckSquareOutlined, KeyOutlined,
  LinkOutlined, SolutionOutlined, BellOutlined, SendOutlined,
  ApartmentOutlined, DeleteOutlined, ClearOutlined,
} from '@ant-design/icons';

// 菜单图标映射（与后端 menus.menu_icon 对应）
const ICON_MAP = {
  DashboardOutlined: <DashboardOutlined />,
  LineChartOutlined: <LineChartOutlined />,
  UserOutlined: <UserOutlined />,
  HeartOutlined: <HeartOutlined />,
  EditOutlined: <EditOutlined />,
  RiseOutlined: <RiseOutlined />,
  HistoryOutlined: <HistoryOutlined />,
  ClockCircleOutlined: <ClockCircleOutlined />,
  ApiOutlined: <ApiOutlined />,
  MobileOutlined: <MobileOutlined />,
  SafetyOutlined: <SafetyOutlined />,
  AppstoreOutlined: <AppstoreOutlined />,
  FundOutlined: <FundOutlined />,
  SettingOutlined: <SettingOutlined />,
  MonitorOutlined: <MonitorOutlined />,
  PictureOutlined: <PictureOutlined />,
  ThunderboltOutlined: <ThunderboltOutlined />,
  BookOutlined: <BookOutlined />,
  ReadOutlined: <ReadOutlined />,
  UnorderedListOutlined: <UnorderedListOutlined />,
  CalendarOutlined: <CalendarOutlined />,
  TeamOutlined: <TeamOutlined />,
  MenuOutlined: <MenuOutlined />,
  DatabaseOutlined: <DatabaseOutlined />,
  ProfileOutlined: <ProfileOutlined />,
  OrderedListOutlined: <OrderedListOutlined />,
  FolderOutlined: <FolderOutlined />,
  AuditOutlined: <AuditOutlined />,
  CheckSquareOutlined: <CheckSquareOutlined />,
  KeyOutlined: <KeyOutlined />,
  LinkOutlined: <LinkOutlined />,
  SolutionOutlined: <SolutionOutlined />,
  BellOutlined: <BellOutlined />,
  SendOutlined: <SendOutlined />,
  ApartmentOutlined: <ApartmentOutlined />,
  DeleteOutlined: <DeleteOutlined />,
  ClearOutlined: <ClearOutlined />,
};
const iconOf = (name) => ICON_MAP[name] || <AppstoreOutlined />;

/** 根据昵称生成首字符渐变头像（data URI，与小程序用户头像风格一致） */
function letterAvatar(nickname, size = 32) {
  const ch = String(nickname || '').trim().charAt(0) || '云';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4d9fff"/>
      <stop offset="1" stop-color="#7c6cff"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size / 4}" fill="url(#g)"/>
  <text x="50%" y="50%" dy=".36em" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${size * 0.5}" fill="#ffffff">${ch}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [menus, setMenus] = useState(null);   // null = 加载中
  const [routes, setRoutes] = useState([]);
  const [leafPaths, setLeafPaths] = useState([]);
  const [openKeys, setOpenKeys] = useState([]);
  // 可管理的小程序（多小程序切换器）：仅多应用时显示
  const [apps, setApps] = useState([]);
  const [currentApp, setCurrentApp] = useState(localStorage.getItem('admin_app') || '');

  const [staff, setStaff] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('admin_user') || '{}');
    } catch (_) {
      return {};
    }
  });

  // 进入时校验/刷新当前用户信息（角色被后台修改后前端即时生效；401 由拦截器跳登录）
  useEffect(() => {
    authApi.me()
      .then(res => {
        const s = res.data.staff || {};
        if (s.staff_id) {
          const local = {
            staff_id: s.staff_id,
            username: s.username,
            nickname: s.nickname,
            role: s.role,
          };
          localStorage.setItem('admin_user', JSON.stringify(local));
          setStaff(local);
        }
      })
      .catch(() => {});
  }, []);

  // 加载可管理的小程序：非单应用时顶栏展示切换器
  useEffect(() => {
    authApi.myApps()
      .then(res => {
        const list = res.data.apps || [];
        setApps(list);
        const cur = res.data.current || '';
        if (!list.some(a => a.app_id === localStorage.getItem('admin_app'))) {
          setCurrentApp(cur);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    menuApi.list()
      .then(res => {
        const groups = res.data.menus || [];
        const built = groups
          .filter(g => g.type === 'group' || g.type === 'leaf')
          .map(g => {
            if (g.type === 'leaf') {
              return { path: g.path, name: g.name, icon: iconOf(g.icon) };
            }
            return {
              path: g.path,
              name: g.name,
              icon: iconOf(g.icon),
              routes: (g.children || []).map(c => ({ path: c.path, name: c.name, icon: iconOf(c.icon) })),
            };
          });
        // 收集所有叶子路径
        const leaves = [];
        groups.forEach(g => {
          if (g.type === 'leaf') leaves.push(g.path);
          (g.children || []).forEach(c => leaves.push(c.path));
        });
        setRoutes(built);
        setLeafPaths(leaves.filter(Boolean));
      })
      .catch(() => setRoutes([]))
      .finally(() => setMenus([]));
  }, []);

  // 当前路径不在权限内 → 跳转到第一个有权限的叶子页面
  useEffect(() => {
    if (menus === null || leafPaths.length === 0) return;
    const cur = location.pathname;
    if (!leafPaths.includes(cur)) {
      navigate(leafPaths[0], { replace: true });
    }
  }, [menus, leafPaths, location.pathname, navigate]);

  // 菜单展开状态：路由变化时只展开当前路径所属的一级菜单分组，其余收起
  // （避免点击某个二级菜单时其他一级菜单也自动展开）
  useEffect(() => {
    if (routes.length === 0) return;
    const cur = location.pathname;
    const parent = routes.find(g => g.routes && g.routes.some(c => c.path === cur));
    setOpenKeys(parent ? [parent.path] : []);
  }, [routes, location.pathname]);

  // 手动展开/收起：只保留一级分组 key，且只保留最近打开的一个（其他一级菜单始终闭合）
  const onMenuOpenChange = (keys) => {
    const groupSet = new Set(routes.filter(g => g.routes).map(g => g.path));
    const valid = (keys || []).filter(k => groupSet.has(k));
    setOpenKeys(valid.slice(-1));
  };

  const onLogout = () => {
    // 先上报退出登录审计（fire-and-forget，失败不影响本地退出）
    auditApi.logout().catch(() => {});
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_user');
    message.success('已退出登录');
    window.location.href = '/admin/login';
  };

  // 点击菜单 → 上报审计（menu_click），静默失败
  const onMenuClick = (item) => {
    auditApi.report({
      eventType: 'menu_click',
      eventName: `点击菜单：${item.name || item.path}`,
      module: 'menu',
      pagePath: item.path || '',
    }).catch(() => {});
  };

  // 切换小程序：写入 admin_app 后整页刷新（后续请求自动携带 app 参数）
  const onSwitchApp = (appId) => {
    if (appId === currentApp) return;
    localStorage.setItem('admin_app', appId);
    window.location.href = '/admin/';
  };

  return (
    <ProLayout
      title="课小满后台管理系统"
      logo={false}
      layout="mix"
      navTheme="light"
      fixedHeader
      location={{ pathname: location.pathname }}
      route={{ path: '/', routes }}
      menu={{ autoClose: true }}
      openKeys={openKeys}
      onOpenChange={onMenuOpenChange}
      menuItemRender={(item, dom) => (item.routes ? dom : <Link to={item.path || '/'} onClick={() => onMenuClick(item)}>{dom}</Link>)}
      onMenuHeaderClick={() => navigate(leafPaths[0] || '/dashboard/monitor')}
      avatarProps={{
        src: letterAvatar(staff.nickname || staff.username),
        title: staff.nickname || staff.username,
        render: (_, dom) => (
          <Dropdown
            menu={{
              items: [
                { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: onLogout },
              ],
            }}
          >
            {dom}
          </Dropdown>
        ),
      }}
      actionsRender={() => (
        apps.length > 1 ? [
          <Dropdown
            key="app-switcher"
            menu={{
              selectable: true,
              selectedKeys: [currentApp || apps[0]?.app_id],
              items: apps.map(a => ({
                key: a.app_id,
                label: a.app_name || a.app_id,
                onClick: () => onSwitchApp(a.app_id),
              })),
            }}
          >
            <span style={{ cursor: 'pointer', marginRight: 12, color: 'rgba(0,0,0,0.65)' }}>
              <AppstoreOutlined /> {currentApp ? (apps.find(a => a.app_id === currentApp)?.app_name || currentApp) : (apps[0]?.app_name || '')}
            </span>
          </Dropdown>,
        ] : []
      )}
      contentStyle={{ minHeight: '100vh' }}
    >
      <div style={{ padding: 16 }}>
        <Outlet />
      </div>
    </ProLayout>
  );
}
