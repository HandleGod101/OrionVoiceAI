# Share Orion with another laptop

Place `share_windows.bat` and `share_mac.sh` alongside `app.py`.
These launchers share the app already running on port 8000. They do not install software or change the app.

## 1. Install Cloudflare Tunnel once

If cloudflared is already installed, skip this step.

Windows PowerShell:
```powershell
winget install --id Cloudflare.cloudflared --exact
```
Reopen your terminal after installation. The Windows launcher also checks `C:\Program Files (x86)\cloudflared\cloudflared.exe` and `C:\Program Files\cloudflared\cloudflared.exe`.

macOS with Homebrew:
```bash
brew install cloudflared
```

## 2. Start Orion

In your project folder, activate your existing Python environment and run:
```bash
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```
Check that http://127.0.0.1:8000 opens the Orion app.

## 3. Start sharing

Windows: double-click `share_windows.bat`.

Mac: open a second terminal in the project folder and run:
```bash
bash share_mac.sh
```

Copy the `https://...trycloudflare.com` URL printed in the tunnel window. Send it to your colleague; they open it in their browser and allow microphone access. They do not need Python or cloudflared.

Keep both the app and tunnel running, and keep the host computer awake. Press Ctrl+C in the tunnel window to stop sharing. A new tunnel normally gets a new URL.

The URL exposes the app publicly without a login. Anyone with access can start calls using your configured API account, so share only with trusted testers.

## Troubleshooting

- **App not responding / 502:** Check Orion is running on port 8000 and opens locally. If another project uses port 8000, stop it first or change the app port and launcher URLs together.
- **No public URL:** Check internet access and cloudflared's error output. Existing `.cloudflared/config.yaml` configuration can interfere with Quick Tunnels; consult the documentation before changing an existing tunnel configuration.
- **Microphone unavailable:** Open the public HTTPS URL and allow microphone permission in the browser.
- **Page loads but voice fails:** The other laptop also needs connectivity to the voice service; check its browser console and network restrictions.

Cloudflare reference: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
