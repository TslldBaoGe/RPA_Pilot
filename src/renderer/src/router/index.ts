import { createRouter, createWebHashHistory } from 'vue-router'
import TasksView from '../views/TasksView.vue'
import RunsView from '../views/RunsView.vue'
import EnvironmentView from '../views/EnvironmentView.vue'
import SettingsView from '../views/SettingsView.vue'

/**
 * 桌面应用走 file:// 加载，必须用 hash 模式，否则刷新会 404。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/tasks' },
    { path: '/tasks', name: 'tasks', component: TasksView },
    { path: '/runs', name: 'runs', component: RunsView },
    { path: '/env', name: 'env', component: EnvironmentView },
    { path: '/settings', name: 'settings', component: SettingsView }
  ]
})
