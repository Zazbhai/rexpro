/* ==========================================================================
   REX AUTOMATION DASHBOARD - DYNAMIC SCRIPT
   ========================================================================= */

document.addEventListener("DOMContentLoaded", () => {
    // API Endpoints
    const STATUS_API = "/api/status";
    const CONFIG_API = "/api/config";
    const ACCOUNTS_API = "/api/accounts";
    const START_API = "/api/bot/start";
    const STOP_API = "/api/bot/stop";
    const LOGS_STREAM_API = "/api/logs/stream";
    const FAILED_ACCOUNTS_API = "/api/failed-accounts";

    // DOM Elements
    const startBtn = document.getElementById("start-btn");
    const stopBtn = document.getElementById("stop-btn");
    const modeRadios = document.getElementsByName("bot-mode");
    const botStateBadge = document.getElementById("bot-state-badge");
    const botStateText = document.getElementById("bot-state-text");
    const balanceValue = document.getElementById("balance-value");
    const serverStatusPill = document.getElementById("server-status");
    const clearLogsBtn = document.getElementById("clear-logs-btn");
    const logTerminal = document.getElementById("log-terminal");

    // Stats Elements
    const statSuccess = document.getElementById("stat-success");
    const statErrors = document.getElementById("stat-errors");
    const statTotal = document.getElementById("stat-total");

    // Config Form Elements
    const configForm = document.getElementById("config-form");
    const apiKeyInput = document.getElementById("cfg-api-key");
    const smsUrlInput = document.getElementById("cfg-sms-url");
    const targetUrlInput = document.getElementById("cfg-target-url");
    const countryInput = document.getElementById("cfg-country");
    const operatorInput = document.getElementById("cfg-operator");
    const serviceInput = document.getElementById("cfg-service");
    const inviteInput = document.getElementById("cfg-invite");
    const passwordInput = document.getElementById("cfg-password");
    const concurrencyInput = document.getElementById("cfg-concurrency");
    const otpWaitInput = document.getElementById("cfg-otp-wait");
    const proxyInput = document.getElementById("cfg-proxy");
    const toggleApiKeyBtn = document.getElementById("toggle-api-key");
    const saveStatus = document.getElementById("save-status");

    // Accounts History Elements
    const tableBody = document.getElementById("accounts-table-body");
    const refreshBtn = document.getElementById("refresh-btn");
    const exportBtn = document.getElementById("export-btn");
    const failedTableBody = document.getElementById("failed-table-body");
    const failedRefreshBtn = document.getElementById("failed-refresh-btn");

    // Modal Elements
    const errorModal = document.getElementById("error-modal");
    const closeModalBtn = document.getElementById("close-modal-btn");
    const modalTitle = document.getElementById("modal-title");
    const modalMessage = document.getElementById("modal-message");

    // Login Overlay Elements
    const loginOverlay = document.getElementById("login-overlay");
    const loginForm = document.getElementById("login-form");
    const loginPasswordInput = document.getElementById("login-password");
    const loginError = document.getElementById("login-error");

    // Logging & SSE State
    let eventSource = null;
    let pollIntervalId = null;

    // -------------------------------------------------------------
    // Core Functions
    // -------------------------------------------------------------

    function getAuthHeaders() {
        const token = localStorage.getItem("rex_auth_token") || "";
        return {
            "Authorization": `Bearer ${token}`
        };
    }

    async function apiFetch(url, options = {}) {
        const headers = {
            ...options.headers,
            ...getAuthHeaders()
        };
        const res = await fetch(url, { ...options, headers });
        if (res.status === 401) {
            localStorage.removeItem("rex_auth_token");
            showLoginScreen();
            throw new Error("Session expired. Please log in.");
        }
        return res;
    }

    function showLoginScreen() {
        loginOverlay.classList.add("active");
        loginPasswordInput.value = "";
        loginPasswordInput.focus();
    }

    function hideLoginScreen() {
        loginOverlay.classList.remove("active");
    }

    // Helper to safely parse API responses
    async function safeParse(res) {
        if (!res.ok) {
            let errorMsg = `Server returned status ${res.status}`;
            const contentType = res.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                const errJson = await res.json();
                errorMsg = errJson.error || errorMsg;
            } else {
                const errText = await res.text();
                // Strip HTML tags for clean error representation
                errorMsg = errText.replace(/<[^>]*>/g, '').trim() || errorMsg;
                if (errorMsg.length > 100) errorMsg = errorMsg.substring(0, 100) + "...";
            }
            throw new Error(errorMsg);
        }
        return await res.json();
    }

    // Helper to format timestamps
    function formatTime(isoString) {
        if (!isoString) return "N/A";
        const date = new Date(isoString);
        return date.toLocaleString();
    }

    // Server Connectivity Status
    function setOnline(isOnline) {
        if (isOnline) {
            serverStatusPill.classList.remove("offline");
            serverStatusPill.classList.add("online");
            serverStatusPill.querySelector(".status-text").textContent = "Connected";
        } else {
            serverStatusPill.classList.remove("online");
            serverStatusPill.classList.add("offline");
            serverStatusPill.querySelector(".status-text").textContent = "Offline";
            balanceValue.textContent = "Error";
        }
    }

    // Load System Configuration
    async function loadConfig() {
        try {
            const res = await apiFetch(CONFIG_API);
            const config = await safeParse(res);
            
            apiKeyInput.value = config.API_KEY || "";
            smsUrlInput.value = config.SMS_BASE_URL || "";
            targetUrlInput.value = config.TARGET_BASE_URL || "";
            countryInput.value = config.COUNTRY || "";
            operatorInput.value = config.OPERATOR || "";
            serviceInput.value = config.SERVICE || "";
            inviteInput.value = config.INVITE_CODE || "";
            passwordInput.value = config.PASSWORD || "";
            concurrencyInput.value = config.CONCURRENCY || 3;
            otpWaitInput.value = config.OTP_WAIT_TIME || 30;
            proxyInput.value = config.PROXY || "";
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to load configurations: ${err.message}`, "error");
        }
    }

    // Load Registered Accounts Database Table
    async function loadAccounts() {
        try {
            const res = await apiFetch(ACCOUNTS_API);
            const accounts = await safeParse(res);
            
            renderAccountsTable(accounts);
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to load accounts history: ${err.message}`, "error");
        }
    }

    // Load Failed Registration Accounts Table
    async function loadFailedAccounts() {
        try {
            const res = await apiFetch(FAILED_ACCOUNTS_API);
            const failures = await safeParse(res);
            
            renderFailedAccountsTable(failures);
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to load failed accounts: ${err.message}`, "error");
        }
    }

    // Render Failed Accounts List into table
    function renderFailedAccountsTable(failures) {
        if (!failures || failures.length === 0) {
            failedTableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-state">
                        <i class="fa-solid fa-circle-check" style="color: var(--success); font-size: 32px; margin-bottom: 10px;"></i>
                        <p>No failed registration attempts with OTPs recorded.</p>
                    </td>
                </tr>
            `;
            return;
        }

        failedTableBody.innerHTML = failures.map((acc, index) => {
            return `
                <tr>
                    <td class="cell-mono">${index + 1}</td>
                    <td class="cell-phone cell-mono">${acc.phoneNumber}</td>
                    <td class="cell-mono">${acc.password}</td>
                    <td class="cell-mono">${acc.smsCode}</td>
                    <td style="color: var(--danger); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: normal;">${acc.error}</td>
                    <td>${formatTime(acc.createdAt)}</td>
                    <td>
                        <div class="table-actions">
                            <button class="btn-icon" onclick="copyText('${acc.phoneNumber}', 'Phone')" title="Copy Phone Number">
                                <i class="fa-solid fa-phone"></i>
                            </button>
                            <button class="btn-icon" onclick="copyText('${acc.smsCode}', 'OTP Code')" title="Copy OTP Code">
                                <i class="fa-solid fa-key"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).reverse().join(""); // Show newest first
    }

    // Render Accounts List into table
    function renderAccountsTable(accounts) {
        if (!accounts || accounts.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-state">
                        <i class="fa-solid fa-database"></i>
                        <p>No registered accounts found in database. Start the bot to create one.</p>
                    </td>
                </tr>
            `;
            return;
        }

        tableBody.innerHTML = accounts.map((acc, index) => {
            return `
                <tr>
                    <td class="cell-mono">${index + 1}</td>
                    <td class="cell-phone cell-mono">${acc.phoneNumber}</td>
                    <td class="cell-mono">${acc.password}</td>
                    <td class="cell-mono">${acc.smsCode}</td>
                    <td class="cell-token" title="${acc.jwtToken}">${acc.jwtToken}</td>
                    <td>${formatTime(acc.createdAt)}</td>
                    <td>
                        <div class="table-actions">
                            <button class="btn-icon" onclick="copyText('${acc.phoneNumber}', 'Phone')" title="Copy Phone Number">
                                <i class="fa-solid fa-phone"></i>
                            </button>
                            <button class="btn-icon" onclick="copyText('${acc.password}', 'Password')" title="Copy Password">
                                <i class="fa-solid fa-key"></i>
                            </button>
                            <button class="btn-icon" onclick="copyText('${acc.jwtToken}', 'JWT Token')" title="Copy JWT Token">
                                <i class="fa-solid fa-file-code"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).reverse().join(""); // Show newest first
    }

    // Update Status, balance, and running stats
    async function updateStatus() {
        try {
            const res = await apiFetch(STATUS_API);
            const status = await safeParse(res);
            
            setOnline(true);
            
            // Balance check
            if (status.balance !== null) {
                balanceValue.textContent = `$${status.balance}`;
            } else {
                balanceValue.textContent = status.balanceRaw || "Error";
            }

            // Stats counts
            statSuccess.textContent = status.successCount;
            statErrors.textContent = status.errorCount;
            statTotal.textContent = status.totalCreated;

            // Running Engine States UI
            if (status.isRunning) {
                botStateBadge.className = "state-badge running";
                botStateText.textContent = "Running";
                startBtn.disabled = true;
                stopBtn.disabled = false;
                for (let radio of modeRadios) radio.disabled = true;
            } else {
                botStateBadge.className = "state-badge stopped";
                botStateText.textContent = "Stopped";
                startBtn.disabled = false;
                stopBtn.disabled = true;
                for (let radio of modeRadios) radio.disabled = false;
            }
        } catch (err) {
            setOnline(false);
        }
    }

    // Connect Server-Sent Events for real-time logs
    function connectLogsStream() {
        if (eventSource) {
            eventSource.close();
        }

        const token = localStorage.getItem("rex_auth_token") || "";
        eventSource = new EventSource(`${LOGS_STREAM_API}?token=${encodeURIComponent(token)}`);

        eventSource.onmessage = (event) => {
            try {
                const log = JSON.parse(event.data);
                
                // Determine log line class based on contents
                let type = "info";
                const msg = log.message.toLowerCase();
                
                if (msg.includes("success") || msg.includes("completed successfully")) {
                    type = "success";
                    // Dynamic table reload on generation success
                    loadAccounts();
                } else if (msg.includes("error") || msg.includes("failed") || msg.includes("failure")) {
                    type = "error";
                    // Reload failures table
                    loadFailedAccounts();
                    
                    // Trigger popup if IP is flagged/blocked
                    if (msg.includes("exceeds the limit") || msg.includes("limit exceeded")) {
                        showModal(
                            "IP Address Flagged", 
                            "Your IP address might be flagged by the target website. Please try again after some time or use rotating proxies."
                        );
                    }
                } else if (msg.includes("warning") || msg.includes("cancelling")) {
                    type = "warning";
                } else if (log.message.startsWith("---")) {
                    type = "system";
                }

                appendLogLine(`[${log.timestamp}] ${log.message}`, type);
            } catch (err) {
                console.error("SSE parse error", err);
            }
        };

        eventSource.onerror = () => {
            console.warn("SSE connection error. Retrying...");
            eventSource.close();
            setTimeout(connectLogsStream, 5000);
        };
    }

    // Append log string to scrolling terminal window
    function appendLogLine(text, type = "info") {
        const line = document.createElement("div");
        line.className = `log-line ${type}`;
        line.textContent = text;
        
        // Auto-scroll logic if user hasn't scrolled up
        const isScrolledToBottom = logTerminal.scrollHeight - logTerminal.clientHeight <= logTerminal.scrollTop + 30;
        
        logTerminal.appendChild(line);

        if (isScrolledToBottom) {
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
    }

    // -------------------------------------------------------------
    // Event Listeners & Button Actions
    // -------------------------------------------------------------

    // Start Bot Action
    startBtn.addEventListener("click", async () => {
        let selectedMode = "once";
        for (let radio of modeRadios) {
            if (radio.checked) {
                selectedMode = radio.value;
                break;
            }
        }

        try {
            const res = await apiFetch(START_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode: selectedMode })
            });
            const data = await safeParse(res);
            
            appendLogLine(`[SYSTEM] Start signal dispatched in '${selectedMode}' mode.`, "system");
            updateStatus();
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to start bot: ${err.message}`, "error");
        }
    });

    // Stop Bot Action
    stopBtn.addEventListener("click", async () => {
        try {
            const res = await apiFetch(STOP_API, { method: "POST" });
            const data = await safeParse(res);
            
            appendLogLine("[SYSTEM] Stop signal dispatched. Stopping after the current execution completes.", "warning");
            updateStatus();
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to stop bot: ${err.message}`, "error");
        }
    });

    // Clear logs screen
    clearLogsBtn.addEventListener("click", () => {
        logTerminal.innerHTML = `<div class="log-line system">[SYSTEM] Console screen cleared by user.</div>`;
    });

    // Toggle API Key password masking
    toggleApiKeyBtn.addEventListener("click", () => {
        if (apiKeyInput.type === "password") {
            apiKeyInput.type = "text";
            toggleApiKeyBtn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
        } else {
            apiKeyInput.type = "password";
            toggleApiKeyBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
        }
    });

    // Save Configurations Form Submit
    configForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        saveStatus.className = "save-status";
        saveStatus.textContent = "Saving config...";

        const payload = {
            API_KEY: apiKeyInput.value.trim(),
            SMS_BASE_URL: smsUrlInput.value.trim(),
            TARGET_BASE_URL: targetUrlInput.value.trim(),
            COUNTRY: countryInput.value.trim(),
            OPERATOR: operatorInput.value.trim(),
            SERVICE: serviceInput.value.trim(),
            INVITE_CODE: inviteInput.value.trim(),
            PASSWORD: passwordInput.value.trim(),
            CONCURRENCY: parseInt(concurrencyInput.value) || 3,
            OTP_WAIT_TIME: parseInt(otpWaitInput.value) || 30,
            PROXY: proxyInput.value.trim()
        };

        try {
            const res = await apiFetch(CONFIG_API, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await safeParse(res);

            saveStatus.className = "save-status success";
            saveStatus.innerHTML = '<i class="fa-solid fa-circle-check"></i> Configurations saved!';
            
            setTimeout(() => {
                saveStatus.textContent = "";
            }, 3000);
            
            // Refresh stats to fetch fresh balance with new configuration
            updateStatus();
        } catch (err) {
            saveStatus.className = "save-status error";
            saveStatus.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Save failed: ${err.message}`;
        }
    });

    // Manual Refresh Table List
    refreshBtn.addEventListener("click", () => {
        loadAccounts();
        loadFailedAccounts();
        updateStatus();
        appendLogLine("[SYSTEM] Database list updated manually.", "system");
    });

    // Manual Refresh Failed List
    failedRefreshBtn.addEventListener("click", () => {
        loadFailedAccounts();
        appendLogLine("[SYSTEM] Failed registrations database refreshed manually.", "system");
    });

    // Export Accounts Database History as JSON file
    exportBtn.addEventListener("click", async () => {
        try {
            const res = await apiFetch(ACCOUNTS_API);
            const accounts = await safeParse(res);
            
            const blob = new Blob([JSON.stringify(accounts, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            
            const a = document.createElement("a");
            a.href = url;
            a.download = `rex_accounts_${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            appendLogLine("[SYSTEM] Database exported successfully.", "success");
        } catch (err) {
            appendLogLine(`[SYSTEM] Failed to export database: ${err.message}`, "error");
        }
    });

    // Initialize App
    const savedToken = localStorage.getItem("rex_auth_token");
    if (!savedToken) {
        showLoginScreen();
    } else {
        hideLoginScreen();
        initDashboard();
    }

    function initDashboard() {
        loadConfig();
        loadAccounts();
        loadFailedAccounts();
        updateStatus();
        connectLogsStream();
        
        if (pollIntervalId) clearInterval(pollIntervalId);
        pollIntervalId = setInterval(updateStatus, 3000);
    }

    // Login Form Submit
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        loginError.style.display = "none";
        loginError.textContent = "";
        
        const password = loginPasswordInput.value;
        try {
            const res = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password })
            });
            
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Authentication failed.");
            }
            
            const data = await res.json();
            localStorage.setItem("rex_auth_token", data.token);
            hideLoginScreen();
            initDashboard();
            appendLogLine("[SYSTEM] Access authorized. Dashboard initialized.", "success");
        } catch (err) {
            loginError.textContent = err.message;
            loginError.style.display = "block";
        }
    });

    // -------------------------------------------------------------
    // Modal Interaction Handlers
    // -------------------------------------------------------------
    function showModal(title, message) {
        modalTitle.textContent = title;
        modalMessage.textContent = message;
        errorModal.classList.add("active");
    }

    closeModalBtn.addEventListener("click", () => {
        errorModal.classList.remove("active");
    });

    errorModal.addEventListener("click", (e) => {
        if (e.target === errorModal) {
            errorModal.classList.remove("active");
        }
    });
});

// Global copy helper function for table actions
function copyText(text, label) {
    navigator.clipboard.writeText(text).then(() => {
        // Show status log in console
        const date = new Date().toLocaleTimeString();
        const logTerminal = document.getElementById("log-terminal");
        if (logTerminal) {
            const line = document.createElement("div");
            line.className = "log-line system";
            line.textContent = `[${date}] [SYSTEM] ${label} copied to clipboard!`;
            logTerminal.appendChild(line);
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
    }).catch(err => {
        console.error("Copy failed", err);
    });
}
