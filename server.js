// Made by Zaz Yagami
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
require("dotenv").config();
const botModule = require("./main");

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "Zazbhai8709#";

const AUTH_TOKEN = crypto.createHash("sha256").update(DASHBOARD_PASSWORD).digest("hex");

function authenticate(req, res, next) {
    let token = req.query.token;
    if (!token) {
        const authHeader = req.headers["authorization"];
        if (authHeader) {
            token = authHeader.split(" ")[1];
        }
    }
    
    if (token !== AUTH_TOKEN) {
        return res.status(401).json({ error: "Access Denied: Invalid or expired session token." });
    }
    next();
}

let activeChildProcesses = [];

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let isRunning = false;
let botMode = "once"; 
let successCount = 0;
let errorCount = 0;
const logBuffer = [];
let sseClients = [];

function broadcastLog(text) {
    const logEntry = {
        timestamp: new Date().toLocaleTimeString(),
        message: text
    };
    logBuffer.push(logEntry);
    if (logBuffer.length > 500) {
        logBuffer.shift();
    }
    console.log(`[BOT] ${text}`);

    const data = JSON.stringify(logEntry);
    sseClients.forEach(client => {
        try {
            client.write(`data: ${data}\n\n`);
        } catch (err) {
            
        }
    });
}

function getPythonExecutable() {
    const isWin = process.platform === "win32";
    const venvPaths = ["venv", ".venv"];
    
    for (const venv of venvPaths) {
        const binDir = isWin ? "Scripts" : "bin";
        const exeName = isWin ? "python.exe" : "python";
        const fullPath = path.join(__dirname, venv, binDir, exeName);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    
    return isWin ? "python" : "python3";
}

function runPlaywrightScript(workerId) {
    return new Promise((resolve, reject) => {
        const pythonExe = getPythonExecutable();
        const child = spawn(pythonExe, ["-u", "register_automation.py"], {
            cwd: __dirname
        });

        activeChildProcesses.push(child);

        let stdoutRemainder = "";
        let stderrRemainder = "";

        child.stdout.on("data", (data) => {
            stdoutRemainder += data.toString();
            const lines = stdoutRemainder.split("\n");
            stdoutRemainder = lines.pop();
            lines.forEach(line => {
                const cleanLine = line.trim();
                if (cleanLine) {
                    broadcastLog(`[Worker ${workerId}] ${cleanLine}`);
                }
            });
        });

        child.stderr.on("data", (data) => {
            stderrRemainder += data.toString();
            const lines = stderrRemainder.split("\n");
            stderrRemainder = lines.pop();
            lines.forEach(line => {
                const cleanLine = line.trim();
                if (cleanLine) {
                    broadcastLog(`[Worker ${workerId}] [STDERR] ${cleanLine}`);
                }
            });
        });

        child.on("close", (code) => {
            activeChildProcesses = activeChildProcesses.filter(p => p !== child);

            if (stdoutRemainder.trim()) {
                broadcastLog(`[Worker ${workerId}] ${stdoutRemainder.trim()}`);
            }
            if (stderrRemainder.trim()) {
                broadcastLog(`[Worker ${workerId}] [STDERR] ${stderrRemainder.trim()}`);
            }

            if (code === 0) {
                resolve({ success: true });
            } else {
                resolve({ success: false, error: `Process exited with code ${code}` });
            }
        });

        child.on("error", (err) => {
            activeChildProcesses = activeChildProcesses.filter(p => p !== child);
            reject(new Error(`Failed to start child process: ${err.message}`));
        });
    });
}

let activeWorkersCount = 0;

async function runWorker(workerId) {
    activeWorkersCount++;
    broadcastLog(`[Worker ${workerId}] Launched.`);

    try {
        while (isRunning) {
            broadcastLog(`[Worker ${workerId}] Starting registration cycle...`);

            const result = await runPlaywrightScript(workerId);

            if (result.success) {
                successCount++;
                broadcastLog(`[Worker ${workerId}] SUCCESS! Registered successfully.`);
            } else {
                errorCount++;
                broadcastLog(`[Worker ${workerId}] FAILED: ${result.error}`);
            }

            if (botMode === "once" || !isRunning) {
                break;
            }

            const config = botModule.loadConfig();
            const loopDelay = config.LOOP_DELAY !== undefined ? parseInt(config.LOOP_DELAY) : 2;
            broadcastLog(`[Worker ${workerId}] Sleeping for ${loopDelay} seconds before next cycle...`);
            await new Promise(resolve => setTimeout(resolve, loopDelay * 1000));
        }
    } catch (err) {
        errorCount++;
        broadcastLog(`[Worker ${workerId}] Loop exception: ${err.message}`);
    } finally {
        activeWorkersCount--;
        broadcastLog(`[Worker ${workerId}] Stopped.`);

        if (activeWorkersCount === 0) {
            isRunning = false;
            broadcastLog("All workers stopped. Automation execution completed.");
        }
    }
}

app.post("/api/login", (req, res) => {
    const { password } = req.body;
    if (!password) {
        return res.status(400).json({ error: "Password is required." });
    }
    
    if (password === DASHBOARD_PASSWORD) {
        return res.json({ token: AUTH_TOKEN });
    }
    
    res.status(401).json({ error: "Incorrect password. Access denied." });
});

app.get("/api/logs/stream", authenticate, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    logBuffer.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    sseClients.push(res);

    req.on("close", () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

app.get("/api/status", authenticate, async (req, res) => {
    let balance = null;
    let balanceRaw = "N/A";

    try {
        const config = botModule.loadConfig();
        balanceRaw = await botModule.getBalance(config);
        balance = botModule.parseBalance(balanceRaw);
    } catch (err) {
        balanceRaw = `Error: ${err.message}`;
    }

    let accountsCount = 0;
    try {
        const accountsPath = path.join(__dirname, "accounts.json");
        if (fs.existsSync(accountsPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
            accountsCount = accounts.length;
        }
    } catch (err) {
        
    }

    res.json({
        isRunning,
        botMode,
        successCount,
        errorCount,
        totalCreated: accountsCount,
        balance: balance !== null ? balance.toFixed(2) : null,
        balanceRaw: balanceRaw
    });
});

app.post("/api/bot/start", authenticate, (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: "Bot is already running." });
    }

    const { mode } = req.body;
    botMode = mode === "loop" ? "loop" : "once";
    isRunning = true;

    const config = botModule.loadConfig();
    const concurrency = Math.max(1, parseInt(config.CONCURRENCY) || 1);

    broadcastLog(`Automation started by user in '${botMode}' mode with ${concurrency} parallel workers.`);

    for (let i = 1; i <= concurrency; i++) {
        runWorker(i);
    }

    res.json({ success: true, mode: botMode, concurrency });
});

app.post("/api/bot/stop", authenticate, (req, res) => {
    if (!isRunning) {
        return res.status(400).json({ error: "Bot is not running." });
    }

    isRunning = false;
    broadcastLog("Bot stop requested. Terminating all active browser processes...");

    activeChildProcesses.forEach(child => {
        try {
            child.kill();
        } catch (err) {
            
        }
    });
    activeChildProcesses = [];

    res.json({ success: true });
});

app.get("/api/config", authenticate, (req, res) => {
    res.json(botModule.loadConfig());
});

app.post("/api/config", authenticate, (req, res) => {
    try {
        const newConfig = req.body;

        if (!newConfig.SMS_BASE_URL || !newConfig.API_KEY || !newConfig.TARGET_BASE_URL) {
            return res.status(400).json({ error: "URLs and API Key are required." });
        }

        const configPath = path.join(__dirname, "config.json");
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), "utf8");

        broadcastLog("Configuration updated by user.");
        res.json({ success: true, config: newConfig });
    } catch (err) {
        res.status(500).json({ error: `Failed to save configuration: ${err.message}` });
    }
});

app.get("/api/accounts", authenticate, (req, res) => {
    try {
        const accountsPath = path.join(__dirname, "accounts.json");
        if (fs.existsSync(accountsPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
            return res.json(accounts);
        }
        res.json([]);
    } catch (err) {
        res.status(500).json({ error: `Failed to fetch accounts: ${err.message}` });
    }
});

app.get("/api/failed-accounts", authenticate, (req, res) => {
    try {
        const filePath = path.join(__dirname, "failed_registrations.json");
        if (fs.existsSync(filePath)) {
            const failures = JSON.parse(fs.readFileSync(filePath, "utf8"));
            return res.json(failures);
        }
        res.json([]);
    } catch (err) {
        res.status(500).json({ error: `Failed to fetch failed registrations: ${err.message}` });
    }
});

const os = require("os");
const axios = require("axios");

function getLocalIpAddresses() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === "IPv4" && !iface.internal) {
                ips.push(iface.address);
            }
        }
    }
    return ips;
}

async function getPublicIpAddress() {
    try {
        const response = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 });
        return response.data.ip;
    } catch (err) {
        return "Unknown";
    }
}

app.listen(PORT, async () => {
    console.log(`=========================================`);
    console.log(`  Automation Server listening on port ${PORT}`);
    console.log(`  Open dashboard: http://localhost:${PORT}`);
    const localIps = getLocalIpAddresses();
    localIps.forEach(ip => {
        console.log(`  Local Network Link: http://${ip}:${PORT}`);
    });
    const publicIp = await getPublicIpAddress();
    console.log(`  Public Link (WAN): http://${publicIp}:${PORT}`);
    console.log(`=========================================`);
});