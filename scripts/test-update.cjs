const { app } = require('electron');
const { autoUpdater } = require('electron-updater');


autoUpdater.autoDownload = false;
autoUpdater.logger = console;

autoUpdater.setFeedURL({
  provider: 'github',
  owner: 'noeticforge',
  repo: 'noeticforge',
  private: true
});

autoUpdater.on('update-available', (info) => {
  console.log('✅ 发现可用更新:', info.version);
  app.exit(0);
});
autoUpdater.on('update-not-available', (info) => {
  console.log('❌ 提示无更新:', info?.version);
  app.exit(0);
});
autoUpdater.on('error', (err) => {
  console.log('❌ 检查出错:', err.message);
  app.exit(1);
});

app.whenReady().then(() => {
  console.log('当前模拟环境启动成功，版本:', app.getVersion());
  autoUpdater.checkForUpdates();
});
