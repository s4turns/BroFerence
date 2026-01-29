# Auto-Start WebRTC Services on Boot

This guide explains how to configure your WebRTC services to automatically start when you boot your computer.

## Windows - Docker Desktop Auto-Start

### Step 1: Enable Docker Desktop Auto-Start

1. **Open Docker Desktop**
   - Click the Docker icon in your system tray (bottom-right)
   - Click the gear icon (⚙️) to open Settings

2. **Enable Auto-Start**
   - Go to "General" tab
   - Check ✅ "Start Docker Desktop when you sign in to your computer"
   - Click "Apply & Restart"

### Step 2: Verify Container Restart Policy

Your containers are already configured with `restart: unless-stopped` which means:
- ✅ Containers will automatically start when Docker Desktop starts
- ✅ Containers will restart if they crash
- ❌ Containers will NOT restart if you manually stop them with `docker compose down`

**Current Configuration:**
```yaml
services:
  turn:
    restart: unless-stopped      # ✅ Auto-starts with Docker

  signaling:
    restart: unless-stopped      # ✅ Auto-starts with Docker

  web:
    restart: unless-stopped      # ✅ Auto-starts with Docker
```

### Step 3: Test Auto-Start

1. **Restart your computer**

2. **Wait for Docker Desktop to fully start**
   - Look for the green Docker icon in system tray
   - This may take 30-60 seconds after login

3. **Check services are running**
   - Double-click `check-status.bat`
   - Or run: `docker compose ps`
   - All three services should show "Up"

4. **Test the application**
   - Open http://localhost:8080
   - Should work immediately without manually starting anything!

## Troubleshooting

### Services not starting automatically?

**Check 1: Docker Desktop is set to auto-start**
```
Settings → General → ✅ Start Docker Desktop when you sign in
```

**Check 2: Containers are in the right state**
```bash
# Ensure containers weren't manually stopped
docker compose ps -a

# If they show "Exited", start them:
docker compose up -d
```

**Check 3: View container logs**
```bash
# Check for errors
docker compose logs
```

### Docker Desktop not starting?

1. Check Windows Task Manager → Startup tab
2. "Docker Desktop" should be enabled
3. If disabled, enable it and restart

### Change restart behavior?

**To make containers NOT auto-start:**
```yaml
# Edit docker-compose.yml
restart: "no"
```

**To always restart (even if manually stopped):**
```yaml
restart: always
```

## Alternative: Windows Task Scheduler (Without Docker Auto-Start)

If you want more control, you can use Windows Task Scheduler:

### Create Scheduled Task

1. Open Task Scheduler (taskschd.msc)
2. Create Basic Task
   - Name: "Start WebRTC Services"
   - Trigger: "At log on"
   - Action: "Start a program"
   - Program: `C:\Path\To\webrtc-server\start.bat`
   - Finish

### Using PowerShell Script

Create `start-on-boot.ps1`:
```powershell
# Wait for Docker to be ready
Start-Sleep -Seconds 30

# Start services
Set-Location "G:\My Drive\vibe\webrtc-server"
docker compose up -d
```

Add to Task Scheduler:
- Program: `powershell.exe`
- Arguments: `-ExecutionPolicy Bypass -File "G:\My Drive\vibe\webrtc-server\start-on-boot.ps1"`

## Linux - Systemd Auto-Start

On Linux, the systemd services already auto-start on boot:

```bash
# Check if enabled
sudo systemctl is-enabled coturn webrtc-signaling webrtc-web

# Enable if needed
sudo systemctl enable coturn webrtc-signaling webrtc-web
```

## Verification Commands

**Check Docker auto-start:**
```bash
# Windows (PowerShell)
Get-ScheduledTask | Where-Object {$_.TaskName -like "*Docker*"}

# Or check Docker Desktop settings
# Settings → General → Start Docker Desktop when you sign in
```

**Check container status:**
```bash
# Quick status
docker compose ps

# Detailed info
docker inspect webrtc-server-signaling-1 | grep -i restart

# View restart policy
docker compose config
```

**View uptime:**
```bash
# Shows how long containers have been running
docker compose ps --format "table {{.Name}}\t{{.Status}}"
```

## Summary

✅ **What you need to do:**
1. Enable "Start Docker Desktop when you sign in" in Docker Desktop settings
2. That's it! Your WebRTC services will now auto-start on boot

✅ **What's already configured:**
- All containers have `restart: unless-stopped` policy
- Services will auto-start when Docker starts
- Services will auto-restart if they crash

⚠️ **Important:**
- If you manually stop services with `docker compose down`, they won't restart until you run `start.bat` again
- Use `docker compose restart` if you want to restart without stopping auto-start

📝 **Quick Test:**
1. Restart your computer
2. Wait 1 minute after login
3. Open http://localhost:8080
4. Should work without any manual intervention!
