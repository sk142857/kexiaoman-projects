import React from 'react';
import { useParams } from 'react-router-dom';
import CommonCrud from '../components/CommonCrud';
import DictPage from './DictPage.jsx';
import TodoTasksPage from './TodoTasksPage.jsx';
import CheckinReviewsPage from './CheckinReviewsPage.jsx';
import { MODULES } from '../config/modules.jsx';

export default function ManagePage() {
  const { module } = useParams();
  // 一体化数据字典页（左侧字典类型 + 右侧字典项）
  if (module === 'dicts') return <DictPage key={module} />;
  // 待办任务：学生卡片式待办（仅未完成/进行中任务 + 打卡）
  if (module === 'todo_tasks') return <TodoTasksPage key={module} />;
  // 打卡审核：管理员审核学生打卡（通过/驳回）
  if (module === 'checkin_reviews') return <CheckinReviewsPage key={module} />;
  const cfg = MODULES[module];
  if (!cfg) return <div>模块不存在</div>;
  // key={module}：切换菜单时强制重建 CommonCrud，避免 ProTable 复用上一个模块的 request/数据
  return <CommonCrud key={module} {...cfg} />;
}
