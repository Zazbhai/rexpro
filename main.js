const axios = require("axios");
const fs = require("fs");
const path = require("path");

// -------------------------------------------------------------
// Configuration Helper
// -------------------------------------------------------------
function loadConfig() {
    try {
        const configPath = path.join(__dirname, "config.json");
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, "utf8"));
        }
    } catch (err) {
        console.error("Error reading config.json, using fallback defaults", err);
    }
    return {
        SMS_BASE_URL: "https://zotp.in/stubs/handler_api.php",
        API_KEY: "2ce12168a4f72374207d61fc634ba23c79cf",
        OPERATOR: "10",
        COUNTRY: "22",
        SERVICE: "lmeh",
        TARGET_BASE_URL: "https://rcapi.rexproearn.com/app/user",
        PASSWORD: "Zazbhai8709#",
        INVITE_CODE: "TDPARP",
        CONCURRENCY: 3,
        LOOP_DELAY: 2,
        OTP_POLL_INTERVAL: 1
    };
}

// -------------------------------------------------------------
// Virtual SMS API Helper Functions (Config-Aware)
// -------------------------------------------------------------

/**
 * Perform a GET request with shared base URL and API key to Virtual SMS API.
 * Returns raw text from the API or throws an Error on network/HTTP issues.
 */
async function _httpGet(params, config) {
    const cfg = config || loadConfig();
    const merged = { api_key: cfg.API_KEY, ...params };
    try {
        const response = await axios.get(cfg.SMS_BASE_URL, {
            params: merged,
            timeout: 15000,
            responseType: "text"
        });
        return response.data.trim();
    } catch (err) {
        throw new Error(`API HTTP Error: ${err.response?.status || err.message}`);
    }
}

/** Check account balance. */
async function getBalance(config) {
    return _httpGet({ action: "getBalance" }, config);
}

/** Extract numeric balance from API response. */
function parseBalance(text) {
    if (!text.startsWith("ACCESS_BALANCE:")) {
        return null;
    }
    try {
        return parseFloat(text.split(":")[1]);
    } catch (err) {
        return null;
    }
}

/** Get pricing for the given country/operator. */
async function getPrices(config, country, operator) {
    const cfg = config || loadConfig();
    return _httpGet({
        action: "getPrices",
        country: country || cfg.COUNTRY,
        operator: operator || cfg.OPERATOR,
    }, cfg);
}

/** Parse JSON-like price response into an object; returns {} on failure. */
function parsePrices(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return {};
    }
}

/**
 * Fetch price data and return the price string for the given service,
 * or null if not found.
 */
async function getPriceForService(config, service, country, operator) {
    const cfg = config || loadConfig();
    const raw = await getPrices(cfg, country || cfg.COUNTRY, operator || cfg.OPERATOR);
    const data = parsePrices(raw);

    const srv = service || cfg.SERVICE;
    const ctry = country || cfg.COUNTRY;

    const countryBlock = data[String(ctry)] || {};
    const serviceBlock = countryBlock[srv];
    if (typeof serviceBlock !== "object" || serviceBlock === null) {
        return null;
    }

    const priceKeys = Object.keys(serviceBlock);
    return priceKeys.length > 0 ? priceKeys[0] : null;
}

/**
 * Request a virtual number for a service.
 * Returns { requestId, phoneNumber } or null on parse failure.
 */
async function getNumber(config, service, country, operator) {
    const cfg = config || loadConfig();
    const raw = await _httpGet({
        action: "getNumber",
        service: service || cfg.SERVICE,
        country: country || cfg.COUNTRY,
        operator: operator || cfg.OPERATOR,
    }, cfg);
    const result = parseNumber(raw);
    if (result) {
        try {
            const sharedState = require("./shared_state");
            if (sharedState && typeof sharedState.addRequestId === "function") {
                sharedState.addRequestId(result.requestId);
            }
        } catch (err) {
            // shared_state may not exist in all contexts
        }
    }
    return result;
}

/**
 * Extract { requestId, phoneNumber } from ACCESS_NUMBER response.
 * Strips leading '91' from the phone number if present.
 */
function parseNumber(text) {
    if (!text.startsWith("ACCESS_NUMBER:")) {
        return null;
    }
    try {
        const parts = text.split(":");
        const requestId = parts[1];
        let phoneNumber = parts[2];
        if (phoneNumber.startsWith("91") && phoneNumber.length > 2) {
            phoneNumber = phoneNumber.substring(2);
        }
        return { requestId, phoneNumber };
    } catch (err) {
        return null;
    }
}

/**
 * Poll for OTP/status for up to timeoutSeconds.
 * Returns the OTP string if found; otherwise null.
 */
async function getOtp(requestId, timeoutSeconds = 300, pollInterval = 2, config) {
    const cfg = config || loadConfig();
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (true) {
        const response = await _httpGet({ action: "getStatus", id: requestId }, cfg);
        const { status, otp } = parseOtpResponse(response);

        if ((status === "ok" || status === "cancelled") && otp) {
            return otp;
        }

        if (Date.now() >= deadline) {
            return otp; // may be null
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));
    }
}

/** Generic status update helper (e.g., 3=request new OTP, 8=cancel). */
async function setStatus(status, requestId, config) {
    return _httpGet({ action: "setStatus", status: status, id: requestId }, config);
}

/** Shortcut: ask for another OTP (status=3). */
async function requestNewOtp(requestId, config) {
    return setStatus(3, requestId, config);
}

/** Shortcut: cancel the number (status=8). */
async function cancelNumber(requestId, config) {
    return setStatus(8, requestId, config);
}

/**
 * Interpret cancel response.
 * Returns 'accepted', 'already_cancelled', or raw text if unknown.
 */
function parseCancelStatus(text) {
    if (text.startsWith("ACCESS_CANCEL")) {
        return "accepted";
    }
    if (text.startsWith("ACCESS_CANCEL_ALREADY")) {
        return "already_cancelled";
    }
    return text;
}

/**
 * Extract the first 4-8 digit OTP from the provided text.
 * Returns null if no OTP found.
 */
function extractOtp(text) {
    const matches = text.match(/\b\d{4,8}\b/g);
    if (!matches) {
        return null;
    }
    // Prefer the last match (often the actual OTP)
    return matches[matches.length - 1];
}

/**
 * Parse getStatus response.
 * Returns { status, otp } where otp is string or null.
 */
function parseOtpResponse(text) {
    if (text.startsWith("STATUS_OK:")) {
        const otp = extractOtp(text);
        return { status: "ok", otp };
    }
    if (text.startsWith("STATUS_CANCEL")) {
        return { status: "cancelled", otp: null };
    }
    if (text.startsWith("ACCESS_WAITING")) {
        return { status: "waiting", otp: null };
    }
    return { status: "unknown", otp: extractOtp(text) };
}

/**
 * Ask for a fresh OTP (status=3) and poll until a new OTP different from
 * previousOtp is received, or timeout is reached. Returns the new OTP or null.
 */
async function requestNewOtpUntilNew(
    requestId,
    previousOtp = null,
    timeoutSeconds = 300,
    pollInterval = 2,
    config
) {
    const cfg = config || loadConfig();
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastOtp = previousOtp;

    while (true) {
        await setStatus(3, requestId, cfg);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 1000));

        const otp = await getOtp(requestId, pollInterval, pollInterval, cfg);

        if (otp && otp !== lastOtp) {
            return otp;
        }

        if (Date.now() >= deadline) {
            return null;
        }

        lastOtp = otp || lastOtp;
    }
}

// -------------------------------------------------------------
// Existing Target Application Registration Functions
// -------------------------------------------------------------

async function sendOtp(mobileNo, config, log = console.log) {
    const cfg = config || loadConfig();
    try {
        const response = await axios.post(
            `${cfg.TARGET_BASE_URL}/sendSmsCode`,
            {
                mobileNo: mobileNo
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );

        log(`OTP Response: ${JSON.stringify(response.data)}`);

        if (response.data.code === 200) {
            log("OTP sent successfully through application");
            return true;
        }

        return false;

    } catch (err) {
        log(`OTP Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
        return false;
    }
}

async function registerUser(mobileNo, password, smsCode, inviteCode, config, log = console.log) {
    const cfg = config || loadConfig();
    try {
        const response = await axios.post(
            `${cfg.TARGET_BASE_URL}/register`,
            {
                mobileNo,
                password,
                smsCode,
                inviteCode
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );

        log(`Register Response: ${JSON.stringify(response.data)}`);

        if (response.data.code === 200) {
            log("Registration successful");
            log(`JWT Token: ${response.data.data}`);
            return response.data.data || "SUCCESS";
        }

        const errMsg = response.data.msg || response.data.message || `Registration failed with API code ${response.data.code}`;
        throw new Error(errMsg);

    } catch (err) {
        let errMsg = err.message;
        if (err.response?.data) {
            errMsg = err.response.data.msg || err.response.data.message || JSON.stringify(err.response.data);
        }
        log(`Register Error: ${errMsg}`);
        throw new Error(errMsg);
    }
}

// -------------------------------------------------------------
// Core Automation Lifecycle Execution
// -------------------------------------------------------------

/**
 * Persists details of numbers that failed during target app registration
 * AFTER successfully receiving the OTP from the SMS provider.
 */
function saveFailedRegistration(phoneNumber, password, smsCode, errorMessage, log = console.log) {
    const filePath = path.join(__dirname, "failed_registrations.json");
    let failures = [];
    try {
        if (fs.existsSync(filePath)) {
            failures = JSON.parse(fs.readFileSync(filePath, "utf8"));
        }
    } catch (e) {
        log(`Failed to read failed_registrations.json: ${e.message}`);
    }

    failures.push({
        phoneNumber,
        password,
        smsCode,
        error: errorMessage,
        createdAt: new Date().toISOString()
    });

    try {
        fs.writeFileSync(filePath, JSON.stringify(failures, null, 2), "utf8");
        log(`Logged registration failure details for number ${phoneNumber} with OTP ${smsCode} to database.`);
    } catch (e) {
        log(`Failed to write to failed_registrations.json: ${e.message}`);
    }
}

/**
 * Runs a single cycle of number retrieval, OTP polling, and registration.
 * Appends the successfully created account credentials to accounts.json.
 */
async function runSingleCycle(config, log = console.log) {
    const cfg = config || loadConfig();
    let requestId = null;
    let phoneNumber = null;
    let smsCode = null;

    try {
        log("Checking SMS service balance...");
        const balanceText = await getBalance(cfg);
        const balance = parseBalance(balanceText);
        log(`Balance: ${balance === null ? "unknown" : balance} (raw: ${balanceText})`);

        log(`Requesting virtual number (service=${cfg.SERVICE}, country=${cfg.COUNTRY}, operator=${cfg.OPERATOR})...`);
        const numResult = await getNumber(cfg);
        if (!numResult) {
            throw new Error("Failed to request virtual number.");
        }

        requestId = numResult.requestId;
        phoneNumber = numResult.phoneNumber;
        log(`Successfully obtained number: ${phoneNumber} (Request ID: ${requestId})`);

        // STEP 1: SEND OTP FROM APP
        log(`Sending OTP from target app to ${phoneNumber}...`);
        const otpSent = await sendOtp(phoneNumber, cfg, log);

        if (!otpSent) {
            throw new Error("Failed to trigger OTP send in the application.");
        }

        // STEP 2: POLL FOR OTP
        log("Polling for OTP (30 seconds timeout)...");
        smsCode = await getOtp(requestId, 30, 2, cfg);

        if (!smsCode) {
            throw new Error("Failed to retrieve OTP within timeout limit.");
        }
        log(`Successfully retrieved OTP: ${smsCode}`);

        // STEP 3: REGISTER USER
        log("Registering user with target application...");
        const token = await registerUser(
            phoneNumber,
            cfg.PASSWORD,
            smsCode,
            cfg.INVITE_CODE,
            cfg,
            log
        );

        // Save successfully registered account
        const accountRecord = {
            phoneNumber,
            password: cfg.PASSWORD,
            smsCode,
            jwtToken: token,
            createdAt: new Date().toISOString()
        };

        const accountsPath = path.join(__dirname, "accounts.json");
        let accounts = [];
        try {
            if (fs.existsSync(accountsPath)) {
                accounts = JSON.parse(fs.readFileSync(accountsPath, "utf8"));
            }
        } catch (e) {
            log(`Failed to read accounts.json: ${e.message}`);
        }

        accounts.push(accountRecord);

        try {
            fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), "utf8");
            log(`Account ${phoneNumber} successfully saved to database.`);
        } catch (e) {
            log(`Failed to write to accounts.json: ${e.message}`);
        }

        return { success: true, account: accountRecord };

    } catch (err) {
        log(`Error encountered during run cycle: ${err.message}`);
        
        if (phoneNumber && smsCode) {
            log(`Saving failed registration record for ${phoneNumber}...`);
            saveFailedRegistration(phoneNumber, cfg.PASSWORD, smsCode, err.message, log);
        }

        if (requestId) {
            log(`Attempting to cancel virtual number (Request ID: ${requestId})...`);
            try {
                const cancelText = await cancelNumber(requestId, cfg);
                log(`Cancel response: ${parseCancelStatus(cancelText)}`);
            } catch (cancelErr) {
                log(`Cancel error: ${cancelErr.message}`);
            }
        }
        return { success: false, error: err.message };
    }
}

// -------------------------------------------------------------
// Direct Execution CLI
// -------------------------------------------------------------
async function main() {
    console.log("--- Starting registration cycle via CLI ---");
    const result = await runSingleCycle();
    if (result.success) {
        console.log("CLI Execution Succeeded:", result.account);
    } else {
        console.log("CLI Execution Failed:", result.error);
    }
}

if (require.main === module) {
    main();
}

// Export functions for Server/UI integration
module.exports = {
    loadConfig,
    getBalance,
    parseBalance,
    getPrices,
    parsePrices,
    getPriceForService,
    getNumber,
    parseNumber,
    getOtp,
    setStatus,
    requestNewOtp,
    cancelNumber,
    parseCancelStatus,
    extractOtp,
    parseOtpResponse,
    requestNewOtpUntilNew,
    sendOtp,
    registerUser,
    runSingleCycle,
    saveFailedRegistration
};
