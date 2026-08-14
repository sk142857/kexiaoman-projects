import React, { useState, useMemo, useEffect } from 'react';
import { Form, Input, Button, message } from 'antd';
import { UserOutlined, LockOutlined, CloudOutlined } from '@ant-design/icons';
import { authApi } from '../services/api';
import './Login.css';

export default function Login() {
  const [loading, setLoading] = useState(false);

  // 已登录用户访问登录页直接回首页
  useEffect(() => {
    if (localStorage.getItem('admin_token')) {
      window.location.href = '/admin/';
    }
  }, []);

  // 悬浮粒子（随机位置/时长，仅在挂载时生成一次）
  const particles = useMemo(() =>
    Array.from({ length: 26 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      size: 2 + Math.random() * 4,
      delay: Math.random() * 10,
      duration: 8 + Math.random() * 10,
    })), []);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const res = await authApi.login(values.username, values.password);
      localStorage.setItem('admin_token', res.data.token);
      localStorage.setItem('admin_user', JSON.stringify(res.data.staff));
      message.success('登录成功');
      window.location.href = '/admin/';
    } catch (_) {
      // 错误已在拦截器提示
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-cloud">
      {/* 动态光晕 */}
      <div className="login-aurora login-aurora--1" />
      <div className="login-aurora login-aurora--2" />
      <div className="login-aurora login-aurora--3" />

      {/* 科技网格地平面 */}
      <div className="login-grid" />

      {/* 悬浮粒子 */}
      <div className="login-particles">
        {particles.map(p => (
          <span
            key={p.id}
            className="login-particle"
            style={{
              left: `${p.left}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
            }}
          />
        ))}
      </div>

      {/* 登录卡片 */}
      <div className="login-panel">
        <div className="login-brand">
          <div className="login-logo"><CloudOutlined /></div>
          <h1 className="login-title">综合Cloud管理系统</h1>
          <span className="login-subtitle">CLOUD MANAGEMENT PLATFORM</span>
        </div>

        <Form className="login-form" onFinish={onFinish} size="large">
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input prefix={<UserOutlined />} placeholder="账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button className="login-submit" type="primary" htmlType="submit" block loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>

        <div className="login-footer">综合Cloud管理系统 · 安全接入</div>
      </div>
    </div>
  );
}
