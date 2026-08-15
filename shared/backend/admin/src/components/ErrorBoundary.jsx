import React from 'react';
import { Button, Result } from 'antd';

/**
 * 全局错误边界：子组件渲染异常时兜底展示，避免整页白屏
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[admin] 页面渲染异常', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title="页面出错了"
          subTitle="渲染过程中发生异常，请刷新重试；若持续出现请联系管理员查看控制台日志"
          extra={[
            <Button key="reload" type="primary" onClick={() => window.location.reload()}>
              刷新页面
            </Button>,
          ]}
        />
      );
    }
    return this.props.children;
  }
}
