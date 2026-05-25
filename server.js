const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const botModule = require("./main");

let activeChildProcesses = [];

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// -------------------------------------------------------------
// Global Bot State & In-Memory Logs
// -------------------------------------------------------------
let isRunning = false;
let botMode = "once"; // "once" or "loop"
let successCount = 0;
let errorCount = 0;
const logBuffer = [];
let sseClients = [];

// Broadcast logs to terminal and SSE clients
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
            // Client socket may have been destroyed
        }
    });
}

// -------------------------------------------------------------
// Playwright Python Script Runner
// -------------------------------------------------------------
function runPlaywrightScript(workerId) {
    return new Promise((resolve, reject) => {
        const child = spawn("python", ["-u", "register_automation.py"], {
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

// -------------------------------------------------------------
// Background Registration Workers (Multitasking)
// -------------------------------------------------------------
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

            broadcastLog(`[Worker ${workerId}] Sleeping for 10 seconds before next cycle...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
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

// -------------------------------------------------------------
// API Endpoints
// -------------------------------------------------------------

// Stream live logs in real-time using Server-Sent Events (SSE)
app.get("/api/logs/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send historical logs in buffer
    logBuffer.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    sseClients.push(res);

    req.on("close", () => {
        sseClients = sseClients.filter(client => client !== res);
    });
});

// Fetch current status and statistics
app.get("/api/status", async (req, res) => {
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
        // Ignore files issues
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

// Start the bot execution
app.post("/api/bot/start", (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: "Bot is already running." });
    }

    const { mode } = req.body;
    botMode = mode === "loop" ? "loop" : "once";
    isRunning = true;

    // Load active config to read concurrency count
    const config = botModule.loadConfig();
    const concurrency = Math.max(1, parseInt(config.CONCURRENCY) || 1);

    broadcastLog(`Automation started by user in '${botMode}' mode with ${concurrency} parallel workers.`);
    
    // Spawn threads/workers in parallel
    for (let i = 1; i <= concurrency; i++) {
        runWorker(i);
    }

    res.json({ success: true, mode: botMode, concurrency });
});

// Stop the bot execution
app.post("/api/bot/stop", (req, res) => {
    if (!isRunning) {
        return res.status(400).json({ error: "Bot is not running." });
    }

    isRunning = false;
    broadcastLog("Bot stop requested. Terminating all active browser processes...");
    
    activeChildProcesses.forEach(child => {
        try {
            child.kill();
        } catch (err) {
            // Ignore
        }
    });
    activeChildProcesses = [];

    res.json({ success: true });
});

// Get current configuration
app.get("/api/config", (req, res) => {
    res.json(botModule.loadConfig());
});

// Save new configuration
app.post("/api/config", (req, res) => {
    try {
        const newConfig = req.body;
        
        // Basic validations
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

// Get registered accounts
app.get("/api/accounts", (req, res) => {
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

// Get failed registration accounts (OTP received but registration failed)
app.get("/api/failed-accounts", (req, res) => {
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

// Start the server
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`  Automation Server listening on port ${PORT}`);
    console.log(`  Open dashboard: http://localhost:${PORT}`);
    console.log(`=========================================`);
});
