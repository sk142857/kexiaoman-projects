import React from 'react';
import { Drawer, Descriptions } from 'antd';
import { renderDetailValue } from './fields.jsx';

/**
 * 通用详情抽屉：按 detailFields 元数据展示一条记录的全量字段
 * label 固定宽度且不换行，value 区域可正常换行/折行
 * @param {object} props
 *  - title: 抽屉标题
 *  - open / onClose: 开关控制
 *  - record: 当前记录
 *  - fields: detailFields 数组
 */
export default function DetailDrawer({ title, open, record, fields = [], onClose, width = 780, column = 2 }) {
  return (
    <Drawer title={title} width={width} open={open} onClose={onClose} destroyOnClose>
      <div className="detail-drawer-desc">
        {record && (
          <Descriptions bordered size="small" column={column}>
            {fields.map((f) => (
              <Descriptions.Item key={`${f.name}-${f.label}`} label={f.label} span={f.span || 1}>
                {renderDetailValue(f, record)}
              </Descriptions.Item>
            ))}
          </Descriptions>
        )}
      </div>
    </Drawer>
  );
}
