// PM2 Process Manager Configuration
// Alternative to Docker for managing services

module.exports = {
  apps: [
    {
      name: 'webrtc-signaling',
      script: 'python',
      args: 'signaling_server.py',
      cwd: './server',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'webrtc-web',
      script: 'npx',
      args: 'http-server -p 8080 ./client',
      interpreter: 'none',
      autorestart: true,
      watch: false,
      max_memory_restart: '100M'
    }
  ]
};
