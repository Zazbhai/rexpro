// Made by Zaz Yagami
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
require("dotenv").config();
const botModule = require("./main");

const SUPERADMIN_USERNAME = process.env.SUPERADMIN_USERNAME || "admin";
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || "Otpzfast1#";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "Zazbhai8709#"; // Fallback for old configs

let sessions = {}; // Map of token -> username
let userRoles = {}; // Map of token -> role

const SESSIONS_FILE = path.join(__dirname, "data", "sessions.json");

function loadSessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
            sessions = data.sessions || {};
            userRoles = data.userRoles || {};
        }
    } catch (err) {
        console.error("Failed to load sessions:", err);
    }
}

function saveSessions() {
    try {
        const dataDir = path.dirname(SESSIONS_FILE);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions, userRoles }, null, 2), "utf8");
    } catch (err) {
        console.error("Failed to save sessions:", err);
    }
}

// Load sessions on startup
loadSessions();

function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

function authenticate(req, res, next) {
    let token = req.query.token;
    if (!token) {
        const authHeader = req.headers["authorization"];
        if (authHeader) {
            token = authHeader.split(" ")[1];
        }
    }
    
    if (!token || !sessions[token]) {
        return res.status(401).json({ error: "Access Denied: Invalid or expired session token." });
    }
    req.username = sessions[token];
    req.role = userRoles[token];
    next();
}

function requireSuperAdmin(req, res, next) {
    if (req.role !== "superadmin") {
        return res.status(403).json({ error: "Access Denied: Superadmin privileges required." });
    }
    next();
}

const userStates = {};
function getUserState(username) {
    if (!userStates[username]) {
        userStates[username] = {
            isRunning: false,
            botMode: "once",
            successCount: 0,
            errorCount: 0,
            activeWorkersCount: 0,
            activeChildProcesses: []
        };
    }
    return userStates[username];
}

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const logBuffer = [];
let sseClients = [];

function broadcastLog(text, username) {
    const logEntry = {
        timestamp: new Date().toLocaleTimeString(),
        message: `[${username}] ${text}`,
        username: username
    };
    logBuffer.push(logEntry);
    if (logBuffer.length > 1000) {
        logBuffer.shift();
    }
    console.log(`[BOT][${username}] ${text}`);

    const data = JSON.stringify(logEntry);
    sseClients.forEach(client => {
        try {
            // Send only logs relevant to the client's username (or all if superadmin)
            if (client.username === username || client.role === "superadmin") {
                client.res.write(`data: ${data}\n\n`);
            }
        } catch (err) {}
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

function runPlaywrightScript(workerId, username) {
    return new Promise((resolve, reject) => {
        const pythonExe = getPythonExecutable();
        const child = spawn(pythonExe, ["-u", "register_automation.py", "--username", username], {
            cwd: __dirname
        });

        const state = getUserState(username);
        state.activeChildProcesses.push(child);

        let stdoutRemainder = "";
        let stderrRemainder = "";

        child.stdout.on("data", (data) => {
            stdoutRemainder += data.toString();
            const lines = stdoutRemainder.split("\n");
            stdoutRemainder = lines.pop();
            lines.forEach(line => {
                const cleanLine = line.trim();
                if (cleanLine) broadcastLog(`[Worker ${workerId}] ${cleanLine}`, username);
            });
        });

        child.stderr.on("data", (data) => {
            stderrRemainder += data.toString();
            const lines = stderrRemainder.split("\n");
            stderrRemainder = lines.pop();
            lines.forEach(line => {
                const cleanLine = line.trim();
                if (cleanLine) broadcastLog(`[Worker ${workerId}] [STDERR] ${cleanLine}`, username);
            });
        });

        child.on("close", (code) => {
            state.activeChildProcesses = state.activeChildProcesses.filter(p => p !== child);

            if (stdoutRemainder.trim()) broadcastLog(`[Worker ${workerId}] ${stdoutRemainder.trim()}`, username);
            if (stderrRemainder.trim()) broadcastLog(`[Worker ${workerId}] [STDERR] ${stderrRemainder.trim()}`, username);

            if (code === 0) resolve({ success: true });
            else resolve({ success: false, error: `Process exited with code ${code}` });
        });

        child.on("error", (err) => {
            state.activeChildProcesses = state.activeChildProcesses.filter(p => p !== child);
            reject(new Error(`Failed to start child process: ${err.message}`));
        });
    });
}

async function runWorker(workerId, username) {
    const state = getUserState(username);
    state.activeWorkersCount++;
    broadcastLog(`[Worker ${workerId}] Launched.`, username);

    try {
        while (state.isRunning) {
            broadcastLog(`[Worker ${workerId}] Starting registration cycle...`, username);

            const result = await runPlaywrightScript(workerId, username);

            if (result.success) {
                state.successCount++;
                broadcastLog(`[Worker ${workerId}] SUCCESS! Registered successfully.`, username);
            } else {
                state.errorCount++;
                broadcastLog(`[Worker ${workerId}] FAILED: ${result.error}`, username);
            }

            if (state.botMode === "once" || !state.isRunning) {
                break;
            }

            const config = botModule.loadConfig(username);
            const loopDelay = config.LOOP_DELAY !== undefined ? parseInt(config.LOOP_DELAY) : 2;
            broadcastLog(`[Worker ${workerId}] Sleeping for ${loopDelay} seconds before next cycle...`, username);
            await new Promise(resolve => setTimeout(resolve, loopDelay * 1000));
        }
    } catch (err) {
        state.errorCount++;
        broadcastLog(`[Worker ${workerId}] Loop exception: ${err.message}`, username);
    } finally {
        state.activeWorkersCount--;
        broadcastLog(`[Worker ${workerId}] Stopped.`, username);

        if (state.activeWorkersCount === 0) {
            state.isRunning = false;
            broadcastLog("All workers stopped. Automation execution completed.", username);
        }
    }
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    
    // Backwards compatibility with old login form
    if (req.body.password && !req.body.username && req.body.password === DASHBOARD_PASSWORD) {
        const token = generateToken();
        sessions[token] = "legacy_user";
        userRoles[token] = "superadmin";
        saveSessions();
        const dataDir = path.join(__dirname, "data", "legacy_user");
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        return res.json({ token, role: "superadmin", username: "legacy_user" });
    }
    
    if (!username || !password) return res.status(400).json({ error: "Username and password are required." });
    
    if (username === SUPERADMIN_USERNAME && password === SUPERADMIN_PASSWORD) {
        const token = generateToken();
        sessions[token] = username;
        userRoles[token] = "superadmin";
        saveSessions();
        
        const dataDir = path.join(__dirname, "data", username);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        return res.json({ token, role: "superadmin", username });
    }
    
    try {
        const usersPath = path.join(__dirname, "users.json");
        if (fs.existsSync(usersPath)) {
            const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
            const user = users.find(u => u.username === username && u.password === password);
            if (user) {
                const token = generateToken();
                sessions[token] = username;
                userRoles[token] = user.role || "user";
                saveSessions();
                
                const dataDir = path.join(__dirname, "data", username);
                if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                
                return res.json({ token, role: userRoles[token], username });
            }
        }
    } catch (e) {
        console.error("Error reading users.json", e);
    }
    
    res.status(401).json({ error: "Incorrect credentials. Access denied." });
});

// Superadmin user management endpoints
app.get("/api/users", authenticate, requireSuperAdmin, (req, res) => {
    try {
        const usersPath = path.join(__dirname, "users.json");
        if (fs.existsSync(usersPath)) {
            const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
            return res.json(users.map(u => ({ username: u.username, role: u.role })));
        }
        res.json([]);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch users" });
    }
});

app.post("/api/users", authenticate, requireSuperAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required." });
    
    try {
        const usersPath = path.join(__dirname, "users.json");
        let users = [];
        if (fs.existsSync(usersPath)) users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
        
        if (users.find(u => u.username === username) || username === SUPERADMIN_USERNAME) {
            return res.status(400).json({ error: "Username already exists." });
        }
        
        users.push({ username, password, role: role || "user" });
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        
        const dataDir = path.join(__dirname, "data", username);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to create user" });
    }
});

app.delete("/api/users/:username", authenticate, requireSuperAdmin, (req, res) => {
    const { username } = req.params;
    try {
        const usersPath = path.join(__dirname, "users.json");
        let users = [];
        if (fs.existsSync(usersPath)) users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
        
        users = users.filter(u => u.username !== username);
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        
        // Invalidate sessions for this user
        for (const token in sessions) {
            if (sessions[token] === username) {
                delete sessions[token];
                delete userRoles[token];
            }
        }
        saveSessions();
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete user" });
    }
});

app.post("/api/users/:username/password", authenticate, requireSuperAdmin, (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword) return res.status(400).json({ error: "New password is required." });
    
    try {
        const usersPath = path.join(__dirname, "users.json");
        let users = [];
        if (fs.existsSync(usersPath)) users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
        
        const userIndex = users.findIndex(u => u.username === username);
        if (userIndex === -1) {
            return res.status(404).json({ error: "User not found." });
        }
        
        users[userIndex].password = newPassword;
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        
        // Invalidate sessions for this user
        for (const token in sessions) {
            if (sessions[token] === username) {
                delete sessions[token];
                delete userRoles[token];
            }
        }
        saveSessions();
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update user password." });
    }
});

app.post("/api/clear-data", authenticate, (req, res) => {
    const targetUser = req.body.username || req.username;
    
    if (req.role !== "superadmin" && targetUser !== req.username) {
        return res.status(403).json({ error: "Cannot clear other users' data." });
    }

    try {
        const dataDir = path.join(__dirname, "data", targetUser);
        const accountsPath = path.join(dataDir, "accounts.json");
        const failedPath = path.join(dataDir, "failed_registrations.json");
        
        if (fs.existsSync(accountsPath)) fs.writeFileSync(accountsPath, "[]");
        if (fs.existsSync(failedPath)) fs.writeFileSync(failedPath, "[]");
        
        // Also reset counters for that user
        const state = getUserState(targetUser);
        state.successCount = 0;
        state.errorCount = 0;

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to clear data" });
    }
});

app.post("/api/change-password", authenticate, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: "Both old and new passwords are required." });

    try {
        if (req.role === "superadmin" && req.username === SUPERADMIN_USERNAME) {
            const currentSuperPass = process.env.SUPERADMIN_PASSWORD || "Otpzfast1#";
            if (oldPassword !== currentSuperPass) {
                return res.status(401).json({ error: "Incorrect old password." });
            }
            
            const envPath = path.join(__dirname, ".env");
            let envContent = "";
            if (fs.existsSync(envPath)) {
                envContent = fs.readFileSync(envPath, "utf8");
                if (envContent.includes("SUPERADMIN_PASSWORD=")) {
                    envContent = envContent.replace(/SUPERADMIN_PASSWORD=.*/g, `SUPERADMIN_PASSWORD="${newPassword}"`);
                } else {
                    envContent += `\nSUPERADMIN_PASSWORD="${newPassword}"`;
                }
            } else {
                envContent = `SUPERADMIN_PASSWORD="${newPassword}"`;
            }
            fs.writeFileSync(envPath, envContent, "utf8");
            process.env.SUPERADMIN_PASSWORD = newPassword; 
            return res.json({ success: true });
        } else {
            const usersPath = path.join(__dirname, "users.json");
            let users = [];
            if (fs.existsSync(usersPath)) {
                users = JSON.parse(fs.readFileSync(usersPath, "utf8"));
            }
            const userIndex = users.findIndex(u => u.username === req.username);
            if (userIndex === -1) {
                return res.status(404).json({ error: "User not found." });
            }
            if (users[userIndex].password !== oldPassword) {
                return res.status(401).json({ error: "Incorrect old password." });
            }
            
            users[userIndex].password = newPassword;
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), "utf8");
            
            // Invalidate old sessions when password is changed
            for (const token in sessions) {
                if (sessions[token] === req.username) {
                    delete sessions[token];
                    delete userRoles[token];
                }
            }
            saveSessions();
            
            return res.json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ error: `Failed to change password: ${err.message}` });
    }
});

app.get("/api/logs/stream", authenticate, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    logBuffer.forEach(log => {
        if (log.username === req.username || req.role === "superadmin") {
            res.write(`data: ${JSON.stringify(log)}\n\n`);
        }
    });

    const clientObj = { res, username: req.username, role: req.role };
    sseClients.push(clientObj);

    req.on("close", () => {
        sseClients = sseClients.filter(c => c !== clientObj);
    });
});

app.get("/api/status", authenticate, async (req, res) => {
    let balance = null;
    let balanceRaw = "N/A";
    
    // For superadmin seeing status, we probably want their own state or a specific user's state. 
    // Here we default to their own bot state unless a query parameter is passed.
    const targetUser = (req.role === "superadmin" && req.query.username) ? req.query.username : req.username;
    const state = getUserState(targetUser);

    try {
        const config = botModule.loadConfig(targetUser);
        balanceRaw = await botModule.getBalance(config);
        balance = botModule.parseBalance(balanceRaw);
    } catch (err) {
        balanceRaw = `Error: ${err.message}`;
    }

    let accountsCount = 0;
    try {
        const accountsPath = path.join(__dirname, "data", targetUser, "accounts.json");
        if (fs.existsSync(accountsPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
            accountsCount = accounts.length;
        }
    } catch (err) {}

    res.json({
        isRunning: state.isRunning,
        botMode: state.botMode,
        successCount: state.successCount,
        errorCount: state.errorCount,
        totalCreated: accountsCount,
        balance: balance !== null ? balance.toFixed(2) : null,
        balanceRaw: balanceRaw
    });
});

app.post("/api/bot/start", authenticate, (req, res) => {
    const targetUser = (req.role === "superadmin" && req.body.username) ? req.body.username : req.username;
    const state = getUserState(targetUser);
    
    if (state.isRunning) {
        return res.status(400).json({ error: "Bot is already running for this user." });
    }

    const { mode } = req.body;
    state.botMode = mode === "loop" ? "loop" : "once";
    state.isRunning = true;

    const config = botModule.loadConfig(targetUser);
    const concurrency = Math.max(1, parseInt(config.CONCURRENCY) || 1);

    broadcastLog(`Automation started by user in '${state.botMode}' mode with ${concurrency} parallel workers.`, targetUser);

    for (let i = 1; i <= concurrency; i++) {
        runWorker(i, targetUser);
    }

    res.json({ success: true, mode: state.botMode, concurrency });
});

app.post("/api/bot/stop", authenticate, (req, res) => {
    const targetUser = (req.role === "superadmin" && req.body.username) ? req.body.username : req.username;
    const state = getUserState(targetUser);
    
    if (!state.isRunning) {
        return res.status(400).json({ error: "Bot is not running for this user." });
    }

    state.isRunning = false;
    broadcastLog("Bot stop requested. Terminating all active browser processes...", targetUser);

    state.activeChildProcesses.forEach(child => {
        try { child.kill(); } catch (err) {}
    });
    state.activeChildProcesses = [];

    res.json({ success: true });
});

app.get("/api/config", authenticate, (req, res) => {
    const targetUser = (req.role === "superadmin" && req.query.username) ? req.query.username : req.username;
    res.json(botModule.loadConfig(targetUser));
});

app.post("/api/config", authenticate, (req, res) => {
    const targetUser = (req.role === "superadmin" && req.body.target_username) ? req.body.target_username : req.username;
    
    try {
        const newConfig = req.body.config || req.body; // allow nested or flat depending on client

        if (!newConfig.SMS_BASE_URL || !newConfig.API_KEY || !newConfig.TARGET_BASE_URL) {
            return res.status(400).json({ error: "URLs and API Key are required." });
        }

        const dataDir = path.join(__dirname, "data", targetUser);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        
        const configPath = path.join(dataDir, "config.json");
        fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), "utf8");

        broadcastLog("Configuration updated by user.", targetUser);
        res.json({ success: true, config: newConfig });
    } catch (err) {
        res.status(500).json({ error: `Failed to save configuration: ${err.message}` });
    }
});

app.get("/api/accounts", authenticate, (req, res) => {
    const targetUser = (req.role === "superadmin" && req.query.username) ? req.query.username : req.username;
    try {
        const accountsPath = path.join(__dirname, "data", targetUser, "accounts.json");
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
    const targetUser = (req.role === "superadmin" && req.query.username) ? req.query.username : req.username;
    try {
        const filePath = path.join(__dirname, "data", targetUser, "failed_registrations.json");
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