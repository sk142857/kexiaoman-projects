import { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Layout, Menu } from 'antd';
import { useNavigate } from 'react-router-dom';
import { statsApi } from '../api';

const { Header, Content, Sider } = Layout;

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    statsApi.overview().then(setStats).catch(() => {});
  }, []);

  const logout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider>
        <div className="logo">学习打卡平台</div>
        <Menu theme="dark" mode="inline" defaultSelectedKeys={['dashboard']}>
          <Menu.Item key="dashboard" onClick={() => navigate('/dashboard')}>
            数据概览
          </Menu.Item>
          <Menu.Item key="users" onClick={() => navigate('/users')}>
            用户管理
          </Menu.Item>
          <Menu.Item key="tasks" onClick={() => navigate('/tasks')}>
            任务管理
          </Menu.Item>
          <Menu.Item key="stats" onClick={() => navigate('/stats')}>
            统计报表
          </Menu.Item>
        </Menu>
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <Button type="link" onClick={logout}>
            退出登录
          </Button>
        </Header>
        <Content style={{ margin: 16 }}>
          <Row gutter={16}>
            <Col span={6}>
              <Card>
                <Statistic title="任务总数" value={stats ? stats.taskTotal : 0} />
              </Card>
            </Col>
            <Col span={6}>
              <Card>
                <Statistic title="打卡总数" value={stats ? stats.checkinTotal : 0} />
              </Card>
            </Col>
            <Col span={6}>
              <Card>
                <Statistic title="用户总数" value={stats ? stats.userTotal : 0} />
              </Card>
            </Col>
            <Col span={6}>
              <Card>
                <Statistic title="已完成任务" value={stats ? stats.doneTaskTotal : 0} />
              </Card>
            </Col>
          </Row>
        </Content>
      </Layout>
    </Layout>
  );
}
