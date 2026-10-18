import axios from 'axios';
import { showToast } from './toast';
export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api' });
api.interceptors.request.use(config => {
  config.baseURL = sessionStorage.getItem('catalysthub_guest_mode') === 'true'
    ? (import.meta.env.VITE_GUEST_API_URL || 'http://localhost:5001/api')
    : (import.meta.env.VITE_API_URL || 'http://localhost:5000/api');
  const token = sessionStorage.getItem('catalysthub_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use(response => response, error => {
  const method = error?.config?.method?.toLowerCase();
  if (method && method !== 'get' && typeof window !== 'undefined') {
    const message = typeof error?.response?.data?.message === 'string'
      ? error.response.data.message
      : 'Unable to connect. Please try again.';
    showToast('error', message, 'Action could not be completed');
  }
  return Promise.reject(error);
});
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) return error.response?.data?.message || 'Unable to connect. Please try again.';
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'We couldn’t complete that action. Please try again.';
}
