/**
 * 请求封装模块
 * 统一处理接口请求、令牌注入与错误提示。
 */
const BASE_URL = 'https://api.example.com/api';

function request(method, path, data) {
  const app = getApp();
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        Authorization: app.globalData.token ? `Bearer ${app.globalData.token}` : ''
      },
      success(res) {
        const body = res.data;
        if (body && body.code === 0) {
          resolve(body.data);
        } else if (body && (body.code === 401 || body.code === 403)) {
          app.clearSession();
          wx.reLaunch({ url: '/pages/mine/mine' });
          reject(body);
        } else {
          wx.showToast({ title: (body && body.message) || '请求失败', icon: 'none' });
          reject(body);
        }
      },
      fail(err) {
        wx.showToast({ title: '网络异常', icon: 'none' });
        reject(err);
      }
    });
  });
}

const api = {
  login: (data) => request('POST', '/auth/login', data),
  register: (data) => request('POST', '/auth/register', data),
  getProfile: () => request('GET', '/user/profile'),
  updateProfile: (data) => request('POST', '/user/profile', data),
  listTask: (params) => request('GET', `/task/list?${qs(params)}`),
  taskDetail: (id) => request('GET', `/task/detail/${id}`),
  createTask: (data) => request('POST', '/task/create', data),
  updateTask: (id, data) => request('POST', `/task/update/${id}`, data),
  deleteTask: (id) => request('POST', `/task/delete/${id}`),
  changeTaskStatus: (id, status) => request('POST', `/task/status/${id}`, { status }),
  createCheckin: (data) => request('POST', '/checkin/create', data),
  listCheckin: (params) => request('GET', `/checkin/list?${qs(params)}`),
  reviewCheckin: (id, data) => request('POST', `/checkin/review/${id}`, data),
  pointLogs: () => request('GET', '/point/logs'),
  pointBalance: () => request('GET', '/point/balance'),
  myBadges: () => request('GET', '/badge/mine')
};

function qs(params) {
  return Object.keys(params || {})
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

module.exports = api;
