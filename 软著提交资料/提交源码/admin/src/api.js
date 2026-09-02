import axios from 'axios';

const http = axios.create({
  baseURL: '/api',
  timeout: 15000
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (body && body.code === 0) {
      return body.data;
    }
    return Promise.reject(new Error((body && body.message) || '请求失败'));
  },
  (err) => {
    if (err.response && err.response.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export const authApi = {
  login: (data) => http.post('/auth/login', data)
};

export const userApi = {
  list: (params) => http.get('/admin/user/list', { params }),
  setStatus: (data) => http.post('/admin/user/status', data)
};

export const taskApi = {
  list: (params) => http.get('/task/list', { params }),
  detail: (id) => http.get(`/task/detail/${id}`),
  create: (data) => http.post('/task/create', data),
  update: (id, data) => http.post(`/task/update/${id}`, data),
  remove: (id) => http.post(`/task/delete/${id}`)
};

export const statsApi = {
  overview: () => http.get('/admin/stats')
};
