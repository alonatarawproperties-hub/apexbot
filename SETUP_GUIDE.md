# Apex Bot — Simple Server Setup (Checklist Style)

Use this if you want to run **your existing Apex repo** on a cloud server (GCP, AWS, etc.).

---

## ✅ STEP 1 — Create your server (cloud VM)
If you already have a VM, skip this.

**Pick these settings:**
1) **Region:** US‑West (Oregon)  
2) **OS:** Ubuntu 22.04  
3) **Size:** 4–8 vCPU, 16–32 GB RAM, SSD  
4) **Firewall:** open **TCP 5000**

---

## ✅ STEP 2 — Connect to the server
1) Open your cloud dashboard  
2) **VM instances → SSH / Connect**  
3) You should see:
```
yourname@your-vm:~$
```

---

## ✅ STEP 3 — Install basics (copy/paste)
```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y curl git build-essential
```

---

## ✅ STEP 4 — Install Node.js (copy/paste)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```
You should see versions like `v20.x.x`.

---

## ✅ STEP 5 — Download Apex bot code (copy/paste)
```bash
git clone https://github.com/alonatarawproperties-hub/apexbot.git
cd apexbot
npm install
```

---

## ✅ STEP 6 — Add your keys (safe setup)
Do **not** paste real keys into chat.

1) Create your `.env` file:
```bash
cat <<'EOF' > .env
TELEGRAM_BOT_TOKEN=replace_me
HELIUS_API_KEY=replace_me
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=replace_me
WEBHOOK_SECRET=replace_me
WALLET_ENCRYPTION_KEY=replace_me
PORT=5000
EOF
```

2) Fill in your values (locally):
- **TELEGRAM_BOT_TOKEN** → from **@BotFather** on Telegram  
- **HELIUS_API_KEY** → from your Helius dashboard  
- **HELIUS_RPC_URL** → optional (app can build it), but clearer to set  
- **WEBHOOK_SECRET** → any random string (example: `openssl rand -hex 32`)  
- **WALLET_ENCRYPTION_KEY** → long random string (encrypts wallets)  

---

## ✅ STEP 7 — Create your Helius webhook
In Helius, create a webhook pointing to:
```
http://<your-server-ip>:5000/webhook/helius
```

**Helius form settings (use these):**
1) **Network:** `mainnet`  
2) **Webhook Type:** `enhanced`  
3) **Transaction Type(s):** `CREATE`  
4) **Account Addresses:** add the PumpFun program ID below  
   - `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`

**Where to find your server IP:**
1) In your cloud dashboard, open **VM instances**  
2) Copy the **External IP / Public IP** for your VM  
3) Use that value in the URL above
   - Example: `http://34.123.45.67:5000/webhook/helius`

In the Helius form, set **Authentication Header** to:
```
Bearer <your WEBHOOK_SECRET>
```

---

## ✅ STEP 8 — Run the bot
```bash
npm run dev
```

You should now see the bot respond to **/start** in Telegram.

---

## ✅ NEXT MOVE (do this now)
✅ Open Telegram → your bot → send **/start**  
✅ If it replies, you’re done  
✅ If it doesn’t reply, make sure `npm run dev` is still running

---

## ✅ OPTIONAL — Keep it running 24/7
Use a process manager so the bot restarts after crashes or reboots.

### Option A — PM2 (simple)
1) Install PM2 (if you see `EACCES`, use the sudo line):
```bash
sudo npm install -g pm2
```
If you cannot use `sudo`, install locally:
```bash
npm install pm2
```
Then use `npx pm2` in the commands below.

2) Build once, then start with your `.env` loaded:
```bash
npm run build
pm2 start "bash -lc 'set -a && source .env && set +a && npm start'" --name apexbot
```

3) Enable auto‑start on reboot:
```bash
pm2 save
pm2 startup
```
PM2 will print one more command — copy/paste it to finish setup.

4) Check logs:
```bash
pm2 status
pm2 logs apexbot
```

### Option B — systemd (server‑grade)
1) Create a service file:
```bash
sudo nano /etc/systemd/system/apexbot.service
```

2) Paste (edit paths + username):
```ini
[Unit]
Description=Apex Bot
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/apexbot
EnvironmentFile=/home/YOUR_USERNAME/apexbot/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

3) Enable + start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable apexbot
sudo systemctl start apexbot
```

4) Check logs:
```bash
sudo systemctl status apexbot
journalctl -u apexbot -f
```
