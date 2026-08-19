import React from 'react';
import { useParams } from 'react-router-dom';
import CommonCrud from '../components/CommonCrud';
import DictPage from './DictPage.jsx';
import TodoTasksPage from './TodoTasksPage.jsx';
import CardTasksPage from './CardTasksPage.jsx';
import CheckinReviewsPage from './CheckinReviewsPage.jsx';
import CheckinCardsPage from './CheckinCardsPage.jsx';
import FileUploadsCardsPage from './FileUploadsCardsPage.jsx';
import { MODULES } from '../config/modules.jsx';

export default function ManagePage() {
  const { module } = useParams();
  // 一体化数据字典页（左侧字典类型 + 右侧字典项）
  if (module === 'dicts') return <DictPage key={module} />;
  // 待办任务：学生卡片式待办（仅未完成/进行中任务 + 打卡）
  if (module === 'todo_tasks') return <TodoTasksPage key={module} />;
  // 任务管理（卡片模式）：与「任务管理」功能一致，卡片网格布局
  if (module === 'card_tasks') return <CardTasksPage key={module} />;
  // 打卡审核：管理员审核学生打卡（通过/驳回）
  if (module === 'checkin_reviews') return <CheckinReviewsPage key={module} />;
  // 打卡管理（卡片式）：卡片网格布局展示打卡记录，查看详情/时间轴/删除
  if (module === 'task_checkins') return <CheckinCardsPage key={module} />;
  // 文件上传记录（卡片式）：图片/语音/视频统一卡片管理，尽量展示全部字段
  if (module === 'file_uploads') return <FileUploadsCardsPage key={module} />;
  const cfg = MODULES[module];
  if (!cfg) return <div>模块不存在</div>;
  // key={module}：切换菜单时强制重建 CommonCrud，避免 ProTable 复用上一个模块的 request/数据
  return <CommonCrud key={module} {...cfg} />;
}
